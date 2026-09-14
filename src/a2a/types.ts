/**
 * A2A (Agent-to-Agent) protocol types — JSON-RPC 2.0 based.
 *
 * Follows the A2A protocol specification:
 * https://a2a-protocol.org/latest/specification/
 */

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────

/** JSON-RPC 2.0 request ids may be strings or numbers. */
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  /** Null when the request id could not be read (parse errors). */
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── A2A Messages ────────────────────────────────────────────────────────

/**
 * A2A JSON-RPC method names in the 0.3 style youagent speaks natively.
 * The 1.0 PascalCase names (ListTasks, CreateTaskPushNotificationConfig, ...)
 * are accepted as aliases by the server, see A2A_V1_METHOD_ALIASES.
 */
export type A2AMethod =
  | 'message/send'
  | 'message/stream'
  | 'tasks/get'
  | 'tasks/list'
  | 'tasks/cancel'
  | 'tasks/resubscribe'
  | 'tasks/pushNotificationConfig/set'
  | 'tasks/pushNotificationConfig/get'
  | 'tasks/pushNotificationConfig/list'
  | 'tasks/pushNotificationConfig/delete';

/**
 * A2A 1.0 method names mapped to the 0.3 names the server registers handlers
 * under. Streaming methods are included so they can be answered with a
 * proper UnsupportedOperationError instead of "method not found".
 */
export const A2A_V1_METHOD_ALIASES: Readonly<Record<string, A2AMethod>> = {
  SendMessage: 'message/send',
  SendStreamingMessage: 'message/stream',
  GetTask: 'tasks/get',
  ListTasks: 'tasks/list',
  CancelTask: 'tasks/cancel',
  SubscribeToTask: 'tasks/resubscribe',
  CreateTaskPushNotificationConfig: 'tasks/pushNotificationConfig/set',
  GetTaskPushNotificationConfig: 'tasks/pushNotificationConfig/get',
  ListTaskPushNotificationConfigs: 'tasks/pushNotificationConfig/list',
  DeleteTaskPushNotificationConfig: 'tasks/pushNotificationConfig/delete',
};

/**
 * A2A error codes (spec section 5.4, Error Code Mappings). A2A-specific
 * errors live in the -32001 to -32099 range; the rest are JSON-RPC 2.0.
 */
export const A2A_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
} as const;

export interface TextPart {
  type: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  type: 'file';
  file: { name?: string; mimeType?: string; uri?: string; bytes?: string };
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  type: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface Message {
  role: 'user' | 'agent';
  parts: Part[];
  messageId: string;
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected';

/** States a task cannot leave through the protocol (no cancel, no follow-up messages). */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'canceled',
  'failed',
  'rejected',
]);

/** True when the state is terminal. */
export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

// ── Request/Response params ─────────────────────────────────────────────

export interface MessageSendParams {
  message: Message;
  configuration?: TaskConfiguration;
}

export interface TaskConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  pushNotificationConfig?: PushNotificationConfig;
}

/** How the agent should authenticate to the client's webhook. */
export interface PushNotificationAuthenticationInfo {
  /** Auth scheme names, e.g. ["Bearer"]. */
  schemes: string[];
  /** Credential material the agent presents, e.g. the bearer token. */
  credentials?: string;
}

export interface PushNotificationConfig {
  /** Server-assigned when omitted on set. */
  id?: string;
  /** Webhook URL the agent POSTs task updates to. */
  url: string;
  /** Opaque token echoed back in the X-A2A-Notification-Token header. */
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
}

/** A push notification config bound to a task (0.3 wire shape). */
export interface TaskPushNotificationConfig {
  taskId: string;
  pushNotificationConfig: PushNotificationConfig;
}

/** Params for tasks/pushNotificationConfig/get: task id plus optional config id. */
export interface GetTaskPushNotificationConfigParams {
  id: string;
  pushNotificationConfigId?: string;
}

/** Params for tasks/pushNotificationConfig/list: the task id. */
export interface ListTaskPushNotificationConfigParams {
  id: string;
}

/** Params for tasks/pushNotificationConfig/delete. */
export interface DeleteTaskPushNotificationConfigParams {
  id: string;
  pushNotificationConfigId: string;
}

export interface TaskIdParams {
  id: string;
}

export interface TaskQueryParams {
  id: string;
  historyLength?: number;
}

/** Params for tasks/list (A2A 1.0 ListTasks). */
export interface ListTasksParams {
  /** Only tasks from this conversation. */
  contextId?: string;
  /** Only tasks in this state. Accepts "working" or the 1.0 form "TASK_STATE_WORKING". */
  status?: TaskState | string;
  /** 1 to 100, default 50. */
  pageSize?: number;
  /** Cursor from a previous response's nextPageToken. */
  pageToken?: string;
  /** Limit history per task: unset = all, 0 = omit, n = last n messages. */
  historyLength?: number;
}

/** Result of tasks/list. Tasks are ordered newest first. */
export interface ListTasksResult {
  tasks: Task[];
  /** Always present; empty string when there are no more pages. */
  nextPageToken: string;
  pageSize: number;
  /** Matching tasks before pagination. */
  totalSize: number;
}

// ── YouAgent custom message types (via DataPart) ────────────────────────
// These are sent as DataPart payloads within standard A2A messages

export interface YouAgentFollowData {
  type: 'youagent/follow';
  agentId: string;
  handle: string;
}

export interface YouAgentUnfollowData {
  type: 'youagent/unfollow';
  agentId: string;
}

export interface YouAgentPostsRequestData {
  type: 'youagent/posts-request';
  since?: string;
  limit?: number;
}

export interface YouAgentPostsResponseData {
  type: 'youagent/posts-response';
  posts: import('../types/post.js').Post[];
}
