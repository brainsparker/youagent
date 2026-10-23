/**
 * A2A HTTP+JSON/REST protocol binding (spec section 11).
 *
 * The REST binding is a second transport over the same task store and
 * method handlers the JSON-RPC binding uses. This module owns the parts
 * that are specific to REST: the route table (spec section 5.3), the
 * error representation (google.rpc.Status JSON, spec section 11.6), the
 * A2A error to HTTP status mapping (spec section 5.4), and the agent
 * card helper that advertises the binding in `supportedInterfaces`.
 *
 * Route shapes follow the v1.0 spec exactly: there is no `/v1` prefix
 * (removed between 0.3 and 1.0), colon-suffixed custom methods are used
 * for `message:send`, `tasks/{id}:cancel` and friends, and push
 * notification configs are a sub-resource of their task.
 */

import type { A2AAgentCard } from '../types/agent-card.js';
import { A2A_BINDING_HTTP_JSON, A2A_BINDING_JSONRPC } from '../types/agent-card.js';
import { A2A_ERROR_CODES, type A2AMethod, type JsonRpcError } from './types.js';

/** Media type for REST request and response bodies (spec section 11.1). */
export const A2A_REST_CONTENT_TYPE = 'application/a2a+json';

/** Plain JSON is accepted on requests too; a2a-js clients send it. */
export const JSON_CONTENT_TYPE = 'application/json';

/** `domain` value on the google.rpc.ErrorInfo detail (spec section 11.6). */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';

/** `@type` of the ErrorInfo detail object. */
export const A2A_ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/**
 * Protocol version the REST interface declares. The REST binding is a
 * transport over the same handlers as the JSON-RPC binding, so it speaks
 * the same wire dialect and shares its declared version.
 */
export { A2A_JSONRPC_PROTOCOL_VERSION as A2A_REST_PROTOCOL_VERSION } from '../types/agent-card.js';

// ── Route table ───────────────────────────────────────────────────────────

/** HTTP methods the binding uses. */
export type RestHttpMethod = 'GET' | 'POST' | 'DELETE';

/** A REST route resolved to the A2A method it maps onto. */
export interface RestRouteMatch {
  /** Canonical (0.3-style) handler name the server registers under. */
  method: A2AMethod | 'agent/getExtendedAgentCard';
  /** 1.0 PascalCase operation name, used for the response dialect. */
  operation: string;
  /** Path parameters: task id and, for config routes, the config id. */
  params: { id?: string; configId?: string };
  /** Whether the route carries a JSON request body. */
  hasBody: boolean;
}

interface RouteDef {
  http: RestHttpMethod;
  /** Path pattern; `{id}` and `{configId}` are placeholders. */
  pattern: string;
  method: RestRouteMatch['method'];
  operation: string;
  hasBody: boolean;
}

/**
 * Spec section 5.3 method mapping, REST column. Order matters only for
 * readability; matching is exact per pattern so there is no ambiguity
 * between `/tasks/{id}` and `/tasks/{id}:cancel` (the colon is part of
 * the final path segment, not a separate one).
 */
export const REST_ROUTES: readonly RouteDef[] = [
  { http: 'POST', pattern: '/message:send', method: 'message/send', operation: 'SendMessage', hasBody: true },
  { http: 'POST', pattern: '/message:stream', method: 'message/stream', operation: 'SendStreamingMessage', hasBody: true },
  { http: 'GET', pattern: '/tasks', method: 'tasks/list', operation: 'ListTasks', hasBody: false },
  { http: 'GET', pattern: '/tasks/{id}', method: 'tasks/get', operation: 'GetTask', hasBody: false },
  { http: 'POST', pattern: '/tasks/{id}:cancel', method: 'tasks/cancel', operation: 'CancelTask', hasBody: false },
  // The spec markdown says POST; the proto's google.api.http annotation
  // says GET. Accept both, as a2a-js does.
  { http: 'POST', pattern: '/tasks/{id}:subscribe', method: 'tasks/resubscribe', operation: 'SubscribeToTask', hasBody: false },
  { http: 'GET', pattern: '/tasks/{id}:subscribe', method: 'tasks/resubscribe', operation: 'SubscribeToTask', hasBody: false },
  {
    http: 'POST',
    pattern: '/tasks/{id}/pushNotificationConfigs',
    method: 'tasks/pushNotificationConfig/set',
    operation: 'CreateTaskPushNotificationConfig',
    hasBody: true,
  },
  {
    http: 'GET',
    pattern: '/tasks/{id}/pushNotificationConfigs',
    method: 'tasks/pushNotificationConfig/list',
    operation: 'ListTaskPushNotificationConfigs',
    hasBody: false,
  },
  {
    http: 'GET',
    pattern: '/tasks/{id}/pushNotificationConfigs/{configId}',
    method: 'tasks/pushNotificationConfig/get',
    operation: 'GetTaskPushNotificationConfig',
    hasBody: false,
  },
  {
    http: 'DELETE',
    pattern: '/tasks/{id}/pushNotificationConfigs/{configId}',
    method: 'tasks/pushNotificationConfig/delete',
    operation: 'DeleteTaskPushNotificationConfig',
    hasBody: false,
  },
  { http: 'GET', pattern: '/extendedAgentCard', method: 'agent/getExtendedAgentCard', operation: 'GetExtendedAgentCard', hasBody: false },
];

/** Compiled matcher for one route pattern. */
interface CompiledRoute extends RouteDef {
  regex: RegExp;
  keys: Array<'id' | 'configId'>;
}

const COMPILED: readonly CompiledRoute[] = REST_ROUTES.map((def) => {
  const keys: Array<'id' | 'configId'> = [];
  const source = def.pattern
    .split(/(\{id\}|\{configId\})/)
    .map((piece) => {
      if (piece === '{id}') {
        keys.push('id');
        // A task id may not contain `/` or `:`; the colon separates the
        // custom-method suffix (`:cancel`, `:subscribe`).
        return '([^/:]+)';
      }
      if (piece === '{configId}') {
        keys.push('configId');
        return '([^/]+)';
      }
      return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return { ...def, regex: new RegExp(`^${source}$`), keys };
});

/**
 * Resolve an HTTP method and URL path to a REST route. Returns undefined
 * when nothing matches; callers answer 404. A matching path with the
 * wrong HTTP method is also undefined (callers may want 405, but the
 * spec defines no body for it, so 404 keeps the surface simple).
 */
export function matchRestRoute(httpMethod: string, pathname: string): RestRouteMatch | undefined {
  const upper = httpMethod.toUpperCase();
  for (const route of COMPILED) {
    if (route.http !== upper) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params: RestRouteMatch['params'] = {};
    route.keys.forEach((key, i) => {
      params[key] = safeDecode(m[i + 1]);
    });
    return { method: route.method, operation: route.operation, params, hasBody: route.hasBody };
  }
  return undefined;
}

/** True when some route exists at this path under any HTTP method. */
export function isRestPath(pathname: string): boolean {
  return COMPILED.some((route) => route.regex.test(pathname));
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ── Error representation ──────────────────────────────────────────────────

/** REST error body: google.rpc.Status in JSON (spec section 11.6). */
export interface RestErrorBody {
  error: {
    /** HTTP status code, repeated in the body as the spec example does. */
    code: number;
    /** google.rpc.Code name, e.g. NOT_FOUND or FAILED_PRECONDITION. */
    status: string;
    message: string;
    details: Array<Record<string, unknown>>;
  };
}

interface ErrorMapping {
  httpStatus: number;
  status: string;
  /** UPPER_SNAKE_CASE A2A error type without the Error suffix. */
  reason: string;
}

const {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  TASK_NOT_FOUND,
  TASK_NOT_CANCELABLE,
  PUSH_NOTIFICATION_NOT_SUPPORTED,
  UNSUPPORTED_OPERATION,
  CONTENT_TYPE_NOT_SUPPORTED,
  INVALID_AGENT_RESPONSE,
  EXTENDED_AGENT_CARD_NOT_CONFIGURED,
  EXTENSION_SUPPORT_REQUIRED,
  VERSION_NOT_SUPPORTED,
} = A2A_ERROR_CODES;

/**
 * Spec section 5.4 (A2A errors) plus the JSON-RPC structural codes the
 * shared handlers raise for bad input. The structural codes have no A2A
 * error type; they surface as INVALID_ARGUMENT with reason
 * REQUEST_MALFORMED, matching a2a-js.
 */
const ERROR_MAPPINGS: ReadonlyMap<number, ErrorMapping> = new Map<number, ErrorMapping>([
  [TASK_NOT_FOUND, { httpStatus: 404, status: 'NOT_FOUND', reason: 'TASK_NOT_FOUND' }],
  [TASK_NOT_CANCELABLE, { httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'TASK_NOT_CANCELABLE' }],
  [
    PUSH_NOTIFICATION_NOT_SUPPORTED,
    { httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
  ],
  [UNSUPPORTED_OPERATION, { httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'UNSUPPORTED_OPERATION' }],
  [CONTENT_TYPE_NOT_SUPPORTED, { httpStatus: 400, status: 'INVALID_ARGUMENT', reason: 'CONTENT_TYPE_NOT_SUPPORTED' }],
  [INVALID_AGENT_RESPONSE, { httpStatus: 500, status: 'INTERNAL', reason: 'INVALID_AGENT_RESPONSE' }],
  [
    EXTENDED_AGENT_CARD_NOT_CONFIGURED,
    { httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' },
  ],
  [EXTENSION_SUPPORT_REQUIRED, { httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'EXTENSION_SUPPORT_REQUIRED' }],
  [VERSION_NOT_SUPPORTED, { httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'VERSION_NOT_SUPPORTED' }],
  [PARSE_ERROR, { httpStatus: 400, status: 'INVALID_ARGUMENT', reason: 'REQUEST_MALFORMED' }],
  [INVALID_REQUEST, { httpStatus: 400, status: 'INVALID_ARGUMENT', reason: 'REQUEST_MALFORMED' }],
  [INVALID_PARAMS, { httpStatus: 400, status: 'INVALID_ARGUMENT', reason: 'REQUEST_MALFORMED' }],
  [METHOD_NOT_FOUND, { httpStatus: 404, status: 'NOT_FOUND', reason: 'METHOD_NOT_FOUND' }],
  [INTERNAL_ERROR, { httpStatus: 500, status: 'INTERNAL', reason: 'INTERNAL' }],
]);

const FALLBACK_MAPPING: ErrorMapping = { httpStatus: 500, status: 'INTERNAL', reason: 'INTERNAL' };

/** HTTP status for an A2A / JSON-RPC error code (spec section 5.4). */
export function restStatusFor(code: number): number {
  return (ERROR_MAPPINGS.get(code) ?? FALLBACK_MAPPING).httpStatus;
}

/**
 * Build the REST error body for a JSON-RPC-shaped error. The ErrorInfo
 * detail is always present so clients can tell apart A2A errors that
 * share an HTTP status (spec section 11.6). Any `data` the handler
 * attached travels in ErrorInfo.metadata.
 */
export function toRestErrorBody(error: JsonRpcError): RestErrorBody {
  const mapping = ERROR_MAPPINGS.get(error.code) ?? FALLBACK_MAPPING;
  const info: Record<string, unknown> = {
    '@type': A2A_ERROR_INFO_TYPE,
    reason: mapping.reason,
    domain: A2A_ERROR_DOMAIN,
  };
  if (error.data !== undefined) {
    info.metadata = error.data;
  }
  return {
    error: {
      code: mapping.httpStatus,
      status: mapping.status,
      message: error.message,
      details: [info],
    },
  };
}

// ── Agent card helper ─────────────────────────────────────────────────────

/**
 * Advertise the HTTP+JSON binding on a card. For every JSON-RPC interface
 * the card declares, an HTTP+JSON interface at the same URL is appended
 * (the REST routes live beside the JSON-RPC endpoint on the same origin
 * and path prefix). Cards that already declare an HTTP+JSON interface
 * are returned unchanged. The JSON-RPC entry stays first, so it remains
 * the preferred interface for clients that honor ordering.
 */
export function withHttpJsonInterface<T extends A2AAgentCard>(card: T): T {
  const interfaces = card.supportedInterfaces ?? [];
  if (interfaces.some((iface) => iface.protocolBinding === A2A_BINDING_HTTP_JSON)) {
    return card;
  }
  const jsonRpc = interfaces.filter((iface) => iface.protocolBinding === A2A_BINDING_JSONRPC);
  if (jsonRpc.length === 0) {
    return card;
  }
  const added = jsonRpc.map((iface) => ({
    url: iface.url,
    protocolBinding: A2A_BINDING_HTTP_JSON,
    protocolVersion: iface.protocolVersion,
    ...(iface.tenant ? { tenant: iface.tenant } : {}),
  }));
  return { ...card, supportedInterfaces: [...interfaces, ...added] };
}

// ── Query parameter coercion ──────────────────────────────────────────────

/**
 * Coerce a query-string value into the type the shared handlers expect.
 * GET and DELETE carry request parameters as strings (spec section 11.5);
 * the JSON-RPC handlers validate numbers as numbers, so decimal strings
 * are converted here. A non-numeric string is passed through unchanged
 * and the handler's own validation rejects it with InvalidParams, which
 * REST reports as 400 INVALID_ARGUMENT.
 */
export function coerceQueryNumber(value: string | null): number | string | undefined {
  if (value === null || value === '') return undefined;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}
