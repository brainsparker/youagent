/**
 * A2A wire-format compatibility helpers.
 *
 * The A2A spec (v0.1 through v0.3.x) discriminates message parts with a
 * `kind` field, and v0.3 requires `kind` object discriminators on Message
 * and Task plus a required `artifactId` on Artifact. youagent <= 0.1 emitted
 * a non-standard `type` discriminator on parts and omitted the object
 * discriminators entirely.
 *
 * These normalizers are applied at every ingest boundary (server request
 * handling, client responses) so youagent speaks spec-shaped A2A on the way
 * out while remaining liberal in what it accepts from older peers.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  Artifact,
  DataPart,
  FilePart,
  Message,
  Part,
  StreamEvent,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from './types.js';

/**
 * Normalize a single part from the wire into a spec-shaped `Part`.
 *
 * Accepts both the spec `kind` discriminator and the legacy youagent `type`
 * discriminator. When both are present, `kind` wins. Throws on unknown or
 * missing discriminators so malformed parts fail loudly at the boundary.
 */
export function normalizePart(part: unknown): Part {
  if (part === null || typeof part !== 'object') {
    throw new Error('Invalid A2A part: expected an object');
  }
  const raw = part as Record<string, unknown>;
  const discriminator = (raw.kind ?? raw.type) as string | undefined;
  const metadata = raw.metadata as Record<string, unknown> | undefined;

  switch (discriminator) {
    case 'text': {
      if (typeof raw.text !== 'string') {
        throw new Error('Invalid A2A text part: missing text');
      }
      const normalized: TextPart = { kind: 'text', text: raw.text };
      if (metadata) normalized.metadata = metadata;
      return normalized;
    }
    case 'file': {
      if (raw.file === null || typeof raw.file !== 'object') {
        throw new Error('Invalid A2A file part: missing file');
      }
      const normalized: FilePart = { kind: 'file', file: raw.file as FilePart['file'] };
      if (metadata) normalized.metadata = metadata;
      return normalized;
    }
    case 'data': {
      if (raw.data === null || typeof raw.data !== 'object') {
        throw new Error('Invalid A2A data part: missing data');
      }
      const normalized: DataPart = { kind: 'data', data: raw.data as Record<string, unknown> };
      if (metadata) normalized.metadata = metadata;
      return normalized;
    }
    default:
      throw new Error(`Invalid A2A part: unknown kind ${JSON.stringify(discriminator ?? null)}`);
  }
}

/** Normalize an array of wire parts. */
export function normalizeParts(parts: unknown): Part[] {
  if (!Array.isArray(parts)) {
    throw new Error('Invalid A2A message: parts must be an array');
  }
  return parts.map(normalizePart);
}

/** Normalize a message from the wire: ensure `kind` and spec-shaped parts. */
export function normalizeMessage(message: unknown): Message {
  if (message === null || typeof message !== 'object') {
    throw new Error('Invalid A2A message: expected an object');
  }
  const raw = message as Record<string, unknown>;
  return {
    ...(raw as unknown as Message),
    kind: 'message',
    parts: normalizeParts(raw.parts ?? []),
  };
}

/** Normalize an artifact from the wire: ensure `artifactId` and spec-shaped parts. */
export function normalizeArtifact(artifact: unknown): Artifact {
  if (artifact === null || typeof artifact !== 'object') {
    throw new Error('Invalid A2A artifact: expected an object');
  }
  const raw = artifact as Record<string, unknown>;
  return {
    ...(raw as unknown as Artifact),
    artifactId: typeof raw.artifactId === 'string' && raw.artifactId !== '' ? raw.artifactId : uuidv4(),
    parts: normalizeParts(raw.parts ?? []),
  };
}

/**
 * Normalize a task received from a remote agent: ensure `kind`, and
 * normalize the status message, history, and artifact parts so downstream
 * code can rely on spec-shaped `part.kind` checks regardless of how old the
 * remote implementation is.
 */
export function normalizeTask(task: unknown): Task {
  if (task === null || typeof task !== 'object') {
    throw new Error('Invalid A2A task: expected an object');
  }
  const raw = task as Record<string, unknown>;
  const normalized: Task = {
    ...(raw as unknown as Task),
    kind: 'task',
  };

  const status = raw.status as Record<string, unknown> | undefined;
  if (status && status.message) {
    normalized.status = {
      ...(status as unknown as Task['status']),
      message: normalizeMessage(status.message),
    };
  }
  if (Array.isArray(raw.history)) {
    normalized.history = raw.history.map(normalizeMessage);
  }
  if (Array.isArray(raw.artifacts)) {
    normalized.artifacts = raw.artifacts.map(normalizeArtifact);
  }

  return normalized;
}

/**
 * Normalize one item received on a task stream (message/stream or
 * tasks/resubscribe) into the 0.3-shaped `StreamEvent` youagent works with.
 *
 * Accepts the bare 0.3 objects (`kind: 'task' | 'message' | 'status-update'
 * | 'artifact-update'`) and the A2A 1.0 `StreamResponse` oneof wrapper
 * (`{ task }`, `{ message }`, `{ statusUpdate }`, `{ artifactUpdate }`).
 * Parts inside are normalized like every other ingest boundary. Throws on
 * shapes that are neither, so a misbehaving peer fails loudly.
 */
export function normalizeStreamEvent(event: unknown): StreamEvent {
  if (event === null || typeof event !== 'object') {
    throw new Error('Invalid A2A stream event: expected an object');
  }
  const raw = event as Record<string, unknown>;

  // A2A 1.0 StreamResponse wrapper.
  if (raw.task !== undefined) return normalizeTask(raw.task);
  if (raw.message !== undefined && raw.parts === undefined) return normalizeMessage(raw.message);
  if (raw.statusUpdate !== undefined) return normalizeStatusUpdate(raw.statusUpdate, true);
  if (raw.artifactUpdate !== undefined) return normalizeArtifactUpdate(raw.artifactUpdate);

  // Bare 0.3 objects.
  switch (raw.kind) {
    case 'task':
      return normalizeTask(raw);
    case 'message':
      return normalizeMessage(raw);
    case 'status-update':
      return normalizeStatusUpdate(raw, false);
    case 'artifact-update':
      return normalizeArtifactUpdate(raw);
    default:
      break;
  }

  // Undiscriminated 0.3 objects: infer from shape.
  if (typeof raw.id === 'string' && raw.status !== undefined) return normalizeTask(raw);
  if (typeof raw.role === 'string' && Array.isArray(raw.parts)) return normalizeMessage(raw);
  if (raw.artifact !== undefined && typeof raw.taskId === 'string') return normalizeArtifactUpdate(raw);
  if (raw.status !== undefined && typeof raw.taskId === 'string') return normalizeStatusUpdate(raw, false);

  throw new Error(`Invalid A2A stream event: unknown shape ${JSON.stringify(Object.keys(raw))}`);
}

function normalizeStatusUpdate(value: unknown, fromV1Wrapper: boolean): TaskStatusUpdateEvent {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid A2A status update: expected an object');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.taskId !== 'string' || typeof raw.contextId !== 'string') {
    throw new Error('Invalid A2A status update: missing taskId or contextId');
  }
  const status = raw.status as Record<string, unknown> | undefined;
  if (!status || typeof status !== 'object' || typeof status.state !== 'string') {
    throw new Error('Invalid A2A status update: missing status.state');
  }
  const state = normalizeStateName(status.state);
  const normalizedStatus: TaskStatusUpdateEvent['status'] = {
    state,
    timestamp: typeof status.timestamp === 'string' ? status.timestamp : new Date().toISOString(),
  };
  if (status.message) normalizedStatus.message = normalizeMessage(status.message);

  const event: TaskStatusUpdateEvent = {
    kind: 'status-update',
    taskId: raw.taskId,
    contextId: raw.contextId,
    status: normalizedStatus,
    // 1.0 has no `final`; the stream closing is the signal. Derive it from the state.
    final: typeof raw.final === 'boolean' && !fromV1Wrapper ? raw.final : isTerminalStateName(state),
  };
  if (raw.metadata && typeof raw.metadata === 'object') {
    event.metadata = raw.metadata as Record<string, unknown>;
  }
  return event;
}

function normalizeArtifactUpdate(value: unknown): TaskArtifactUpdateEvent {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid A2A artifact update: expected an object');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.taskId !== 'string' || typeof raw.contextId !== 'string') {
    throw new Error('Invalid A2A artifact update: missing taskId or contextId');
  }
  const event: TaskArtifactUpdateEvent = {
    kind: 'artifact-update',
    taskId: raw.taskId,
    contextId: raw.contextId,
    artifact: normalizeArtifact(raw.artifact),
  };
  if (typeof raw.append === 'boolean') event.append = raw.append;
  if (typeof raw.lastChunk === 'boolean') event.lastChunk = raw.lastChunk;
  if (raw.metadata && typeof raw.metadata === 'object') {
    event.metadata = raw.metadata as Record<string, unknown>;
  }
  return event;
}

/** Accept "working" or the 1.0 enum spelling "TASK_STATE_WORKING". */
function normalizeStateName(value: string): Task['status']['state'] {
  return value.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-') as Task['status']['state'];
}

function isTerminalStateName(state: string): boolean {
  return state === 'completed' || state === 'canceled' || state === 'failed' || state === 'rejected';
}
