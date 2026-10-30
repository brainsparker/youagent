/**
 * A2A protocol version negotiation and the v1.0 wire dialect.
 *
 * The A2A specification (section 3.6) versions the wire format with an
 * `A2A-Version` service parameter sent as an HTTP header (or, for GET-style
 * bindings, a query parameter). Servers MUST answer in the dialect of the
 * requested `Major.Minor` version, MUST treat an empty value as 0.3, and
 * MUST return `VersionNotSupportedError` (-32009) for versions they do not
 * speak.
 *
 * youagent stores tasks and messages in the 0.3 shape (`kind` discriminators,
 * lowercase task states, `user` / `agent` roles). This module projects that
 * internal shape onto the v1.0 JSON serialization at the transport edge and
 * back again:
 *
 * | Concept            | 0.3 dialect                     | 1.0 dialect                                 |
 * | ------------------ | ------------------------------- | ------------------------------------------- |
 * | Task state         | `working`, `input-required`     | `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED` |
 * | Message role       | `user` / `agent`                | `ROLE_USER` / `ROLE_AGENT`                  |
 * | Part               | `{ kind: "text", text }`        | `{ text }` (oneof text / raw / url / data)  |
 * | File part          | `{ kind: "file", file: {...} }` | `{ url | raw, filename, mediaType }`        |
 * | Object discriminator | `kind: "task"` / `"message"`  | none                                        |
 * | SendMessage result | `Task`                          | `{ task }` or `{ message }`                 |
 * | Error details      | free-form `error.data`          | `error.data: [{ "@type": ..., ... }]`       |
 *
 * Spec references: sections 3.6 (versioning), 4.1 (data model), 5.5 (JSON
 * naming and ProtoJSON enums), 9.2 (service parameters over JSON-RPC) and
 * 9.5 (JSON-RPC error details).
 */

import type {
  Artifact,
  FilePart,
  JsonRpcError,
  Message,
  Part,
  PushNotificationConfig,
  Task,
  TaskPushNotificationConfig,
  TaskState,
  TaskStatus,
} from './types.js';

/** Name of the A2A protocol version service parameter (header and query). */
export const A2A_VERSION_HEADER = 'A2A-Version';

/** Protocol dialects youagent can speak on the wire. */
export type A2AProtocolVersion = '0.3' | '1.0';

/** The dialect assumed when a request carries no `A2A-Version` (spec 3.6.2). */
export const A2A_DEFAULT_PROTOCOL_VERSION: A2AProtocolVersion = '0.3';

/** The dialects the JSON-RPC binding answers in, newest first. */
export const A2A_SUPPORTED_PROTOCOL_VERSIONS: readonly A2AProtocolVersion[] = ['1.0', '0.3'];

/**
 * Pre-1.0 versions whose JSON-RPC wire shape is the one youagent stores
 * natively. youagent itself advertised `0.2.1` before 0.3 support, so peers
 * built against those cards keep working.
 */
const LEGACY_VERSION_ALIASES: ReadonlySet<string> = new Set(['0.1', '0.2', '0.3']);

/** Thrown by `resolveProtocolVersion` for a well-formed but unsupported version. */
export class UnsupportedProtocolVersionError extends Error {
  constructor(readonly requested: string) {
    super(`The requested A2A protocol version ${requested} is not supported by this agent`);
    this.name = 'UnsupportedProtocolVersionError';
  }
}

/**
 * Resolve the dialect for a request from its `A2A-Version` value(s).
 *
 * - Empty, missing or whitespace: 0.3 (spec 3.6.2).
 * - `Major.Minor` or `Major.Minor.Patch`: the patch component is ignored
 *   (spec 3.6: patch versions do not affect compatibility).
 * - `1.0` answers in the v1.0 dialect; `0.1`, `0.2` and `0.3` in the 0.3
 *   dialect.
 * - Anything else throws `UnsupportedProtocolVersionError`.
 */
export function resolveProtocolVersion(raw: string | string[] | null | undefined): A2AProtocolVersion {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (value === '') return A2A_DEFAULT_PROTOCOL_VERSION;
  const match = value.match(/^(\d+)\.(\d+)(?:\.\d+)?$/);
  if (!match) {
    throw new UnsupportedProtocolVersionError(value);
  }
  const majorMinor = `${Number(match[1])}.${Number(match[2])}`;
  if (majorMinor === '1.0') return '1.0';
  if (LEGACY_VERSION_ALIASES.has(majorMinor)) return '0.3';
  throw new UnsupportedProtocolVersionError(value);
}

// ── Enum projections ────────────────────────────────────────────────────

/** `input-required` to `TASK_STATE_INPUT_REQUIRED`. */
export function toV1TaskState(state: TaskState): string {
  return `TASK_STATE_${state.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * `TASK_STATE_INPUT_REQUIRED` to `input-required`. Lowercase 0.3 values pass
 * through unchanged; unknown values are returned as-is so the caller's own
 * validation (for example `normalizeTaskState`) can report them.
 */
export function fromV1TaskState(state: string): string {
  if (!state.startsWith('TASK_STATE_')) return state;
  return state.slice('TASK_STATE_'.length).toLowerCase().replace(/_/g, '-');
}

/** `user` to `ROLE_USER`, `agent` to `ROLE_AGENT`. */
export function toV1Role(role: Message['role']): string {
  return role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER';
}

/**
 * `ROLE_USER` / `ROLE_AGENT` to `user` / `agent`. 0.3 values and unknown
 * strings pass through unchanged.
 */
export function fromV1Role(role: string): string {
  if (role === 'ROLE_USER') return 'user';
  if (role === 'ROLE_AGENT') return 'agent';
  return role;
}

// ── Outbound: internal (0.3) shape to v1.0 JSON ─────────────────────────

/** v1.0 `Part`: exactly one of `text`, `raw`, `url`, `data` plus optional metadata. */
export type V1Part = Record<string, unknown>;

/** Project a stored part onto the v1.0 oneof shape. */
export function toV1Part(part: Part): V1Part {
  const out: V1Part = {};
  switch (part.kind) {
    case 'text':
      out.text = part.text;
      break;
    case 'data':
      out.data = part.data;
      break;
    case 'file': {
      const file = part.file ?? {};
      if (file.uri !== undefined) out.url = file.uri;
      else if (file.bytes !== undefined) out.raw = file.bytes;
      else out.url = '';
      if (file.name !== undefined) out.filename = file.name;
      if (file.mimeType !== undefined) out.mediaType = file.mimeType;
      break;
    }
  }
  if (part.metadata !== undefined) out.metadata = part.metadata;
  return out;
}

/** Project a stored message onto the v1.0 shape (no `kind`, `ROLE_*`, oneof parts). */
export function toV1Message(message: Message): Record<string, unknown> {
  const { kind: _kind, role, parts, ...rest } = message;
  return { ...rest, role: toV1Role(role), parts: parts.map(toV1Part) };
}

/** Project a stored artifact onto the v1.0 shape. */
export function toV1Artifact(artifact: Artifact): Record<string, unknown> {
  return { ...artifact, parts: artifact.parts.map(toV1Part) };
}

/** Project a stored task status onto the v1.0 shape. */
export function toV1TaskStatus(status: TaskStatus): Record<string, unknown> {
  const out: Record<string, unknown> = { ...status, state: toV1TaskState(status.state) };
  if (status.message) out.message = toV1Message(status.message);
  return out;
}

/** Project a stored task onto the v1.0 shape (no `kind`, `TASK_STATE_*`, oneof parts). */
export function toV1Task(task: Task): Record<string, unknown> {
  const { kind: _kind, status, history, artifacts, ...rest } = task;
  const out: Record<string, unknown> = { ...rest, status: toV1TaskStatus(status) };
  if (history !== undefined) out.history = history.map(toV1Message);
  if (artifacts !== undefined) out.artifacts = artifacts.map(toV1Artifact);
  return out;
}

/**
 * Project a JSON-RPC result onto the v1.0 dialect for a given method. Only
 * the shapes youagent's handlers produce are rewritten; anything else (custom
 * handler results, scalars) is returned unchanged.
 *
 * `method` is the 0.3 canonical name the handler was registered under.
 */
export function toV1Result(method: string, result: unknown): unknown {
  switch (method) {
    case 'message/send': {
      // SendMessageResponse is a oneof: { task } or { message }.
      if (isTaskLike(result)) return { task: toV1Task(result) };
      if (isMessageLike(result)) return { message: toV1Message(result) };
      return result;
    }
    case 'tasks/get':
    case 'tasks/cancel':
      return isTaskLike(result) ? toV1Task(result) : result;
    case 'tasks/list': {
      if (result && typeof result === 'object' && Array.isArray((result as { tasks?: unknown }).tasks)) {
        const list = result as { tasks: unknown[] };
        return { ...list, tasks: list.tasks.map((t) => (isTaskLike(t) ? toV1Task(t) : t)) };
      }
      return result;
    }
    default:
      return result;
  }
}

/** ProtoJSON `Any` type URL for `google.rpc.ErrorInfo` (spec 9.5). */
export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/** Domain stamped on `google.rpc.ErrorInfo` details emitted by youagent. */
export const ERROR_INFO_DOMAIN = 'a2a-protocol.org';

/** JSON-RPC error code to the spec's error type name, used as `ErrorInfo.reason`. */
const ERROR_REASONS: Readonly<Record<number, string>> = {
  [-32700]: 'JSON_PARSE_ERROR',
  [-32600]: 'INVALID_REQUEST',
  [-32601]: 'METHOD_NOT_FOUND',
  [-32602]: 'INVALID_PARAMS',
  [-32603]: 'INTERNAL_ERROR',
  [-32001]: 'TASK_NOT_FOUND',
  [-32002]: 'TASK_NOT_CANCELABLE',
  [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  [-32004]: 'UNSUPPORTED_OPERATION',
  [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
  [-32006]: 'INVALID_AGENT_RESPONSE',
  [-32007]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
  [-32008]: 'EXTENSION_SUPPORT_REQUIRED',
  [-32009]: 'VERSION_NOT_SUPPORTED',
};

/**
 * Project a JSON-RPC error onto the v1.0 dialect: `error.data` becomes an
 * array of typed detail objects led by a `google.rpc.ErrorInfo`. Free-form
 * 0.3 `data` is preserved as string-valued `ErrorInfo.metadata`; data that is
 * already a typed array passes through.
 */
export function toV1Error(error: JsonRpcError): JsonRpcError {
  const info: Record<string, unknown> = {
    '@type': ERROR_INFO_TYPE,
    reason: ERROR_REASONS[error.code] ?? 'UNKNOWN',
    domain: ERROR_INFO_DOMAIN,
  };
  const data = error.data;
  if (Array.isArray(data) && data.every(isTypedDetail)) {
    return { code: error.code, message: error.message, data };
  }
  if (data !== undefined) {
    info.metadata = toStringMap(data);
  }
  return { code: error.code, message: error.message, data: [info] };
}

// ── Push notification config shapes ─────────────────────────────────────

/**
 * Project 0.3 push-config params onto the 1.0 request shapes:
 * set: `{ taskId, pushNotificationConfig }` to `{ taskId, ...config }`;
 * get/list/delete: `{ id, pushNotificationConfigId? }` to `{ taskId, id? }`.
 * Other methods pass through.
 */
export function toV1PushParams(method: string, params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const p = params as Record<string, unknown>;
  switch (method) {
    case 'tasks/pushNotificationConfig/set': {
      const config = (p.pushNotificationConfig ?? {}) as Record<string, unknown>;
      return { taskId: p.taskId, ...config };
    }
    case 'tasks/pushNotificationConfig/get':
    case 'tasks/pushNotificationConfig/list':
    case 'tasks/pushNotificationConfig/delete': {
      const out: Record<string, unknown> = { taskId: p.taskId ?? p.id };
      const configId = p.pushNotificationConfigId ?? (p.taskId !== undefined ? p.id : undefined);
      if (configId !== undefined) out.id = configId;
      return out;
    }
    default:
      return params;
  }
}

/** Nest a 1.0 flattened `{ taskId, id, url, ... }` config into the 0.3 shape. */
export function fromV1PushConfig(value: unknown): TaskPushNotificationConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid push notification config: expected an object');
  }
  const v = value as Record<string, unknown>;
  if (v.pushNotificationConfig && typeof v.pushNotificationConfig === 'object') {
    return v as unknown as TaskPushNotificationConfig;
  }
  const { taskId, ...config } = v;
  return { taskId: String(taskId ?? ''), pushNotificationConfig: config as unknown as PushNotificationConfig };
}

/** Unwrap a 1.0 `{ configs, nextPageToken }` list into the 0.3 bare array. */
export function fromV1PushConfigList(value: unknown): TaskPushNotificationConfig[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { configs?: unknown }).configs)
      ? (value as { configs: unknown[] }).configs
      : [];
  return items.map(fromV1PushConfig);
}

// ── Inbound: v1.0 JSON to internal (0.3) shape ──────────────────────────

/**
 * Rewrite a v1.0 oneof part into the discriminated 0.3 shape. Parts that
 * already carry `kind` (or the legacy `type`) are returned untouched so the
 * existing `normalizePart` validation runs on them. Returns `undefined` when
 * the object has none of the oneof fields, so the caller can fail with its
 * own "unknown kind" error.
 */
export function fromV1Part(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (raw.kind !== undefined || raw.type !== undefined) return raw;
  const metadata = raw.metadata;
  if ('text' in raw) {
    return withMetadata({ kind: 'text', text: raw.text }, metadata);
  }
  if ('data' in raw) {
    return withMetadata({ kind: 'data', data: raw.data }, metadata);
  }
  if ('url' in raw || 'raw' in raw) {
    const file: FilePart['file'] = {};
    if (typeof raw.url === 'string') file.uri = raw.url;
    if (typeof raw.raw === 'string') file.bytes = raw.raw;
    if (typeof raw.filename === 'string') file.name = raw.filename;
    if (typeof raw.mediaType === 'string') file.mimeType = raw.mediaType;
    return withMetadata({ kind: 'file', file }, metadata);
  }
  return undefined;
}

/**
 * Unwrap a v1.0 `SendMessageResponse` (`{ task }` or `{ message }`) into the
 * bare object 0.3 returned. Anything else passes through.
 */
export function fromV1SendMessageResult(result: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if ('task' in r && r.task && typeof r.task === 'object') return r.task;
    if ('message' in r && r.message && typeof r.message === 'object') return r.message;
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isTaskLike(value: unknown): value is Task {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Task).id === 'string' &&
    !!(value as Task).status &&
    typeof (value as Task).status === 'object' &&
    typeof (value as Task).status.state === 'string'
  );
}

function isMessageLike(value: unknown): value is Message {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Message).messageId === 'string' &&
    Array.isArray((value as Message).parts)
  );
}

function isTypedDetail(value: unknown): boolean {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>)['@type'] === 'string';
}

function toStringMap(data: unknown): Record<string, string> {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  }
  return { details: typeof data === 'string' ? data : JSON.stringify(data) };
}

function withMetadata(part: Record<string, unknown>, metadata: unknown): Record<string, unknown> {
  if (metadata !== undefined) part.metadata = metadata;
  return part;
}
