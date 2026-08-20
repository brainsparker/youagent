/**
 * A2A (Agent-to-Agent) protocol types — JSON-RPC 2.0 based.
 *
 * Follows the A2A protocol specification:
 * https://a2a-protocol.org/latest/specification/
 */

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── A2A Messages ────────────────────────────────────────────────────────

export type A2AMethod =
  | 'message/send'
  | 'message/stream'
  | 'tasks/get'
  | 'tasks/cancel'
  | 'tasks/resubscribe';

export interface TextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  kind: 'file';
  file: { name?: string; mimeType?: string; uri?: string; bytes?: string };
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

/**
 * Legacy part shapes emitted by youagent <= 0.1, which used a `type`
 * discriminator. The A2A spec has always used `kind` (v0.1 through v0.3.x),
 * so these exist only so older youagent peers keep working. Accepted on
 * ingest via `normalizePart`, never emitted.
 */
export type LegacyPart =
  | (Omit<TextPart, 'kind'> & { type: 'text' })
  | (Omit<FilePart, 'kind'> & { type: 'file' })
  | (Omit<DataPart, 'kind'> & { type: 'data' });

/** A part as it may arrive off the wire: spec-shaped or legacy-shaped. */
export type WirePart = Part | LegacyPart;

export interface Message {
  /** A2A v0.3 object discriminator. Always emitted; tolerated missing on ingest. */
  kind: 'message';
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
  | 'completed'
  | 'canceled'
  | 'failed';

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string;
}

export interface Task {
  /** A2A v0.3 object discriminator. Always emitted; tolerated missing on ingest. */
  kind: 'task';
  id: string;
  contextId: string;
  status: TaskStatus;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  /** Required unique artifact identifier per A2A v0.3. Generated when a legacy peer omits it. */
  artifactId: string;
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

export interface PushNotificationConfig {
  url: string;
  authentication?: { schemes: string[] };
}

export interface TaskIdParams {
  id: string;
}

export interface TaskQueryParams {
  id: string;
  historyLength?: number;
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
