/**
 * A2A client — JSON-RPC 2.0 based agent-to-agent communication.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import { isYouAgent, getAgentIdentifier } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { normalizeStreamEvent, normalizeTask } from './compat.js';
import { fetchAgentCard } from './discovery.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  Message,
  StreamEvent,
  Task,
  Part,
  TextPart,
  DataPart,
  MessageSendParams,
  TaskQueryParams,
  TaskIdParams,
  ListTasksParams,
  ListTasksResult,
  PushNotificationConfig,
  TaskPushNotificationConfig,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  DeleteTaskPushNotificationConfigParams,
  YouAgentFollowData,
  YouAgentUnfollowData,
  YouAgentPostsRequestData,
  YouAgentPostsResponseData,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Options for the streaming client methods. */
export interface StreamOptions {
  /** Abort to stop consuming the stream early; the connection is closed. */
  signal?: AbortSignal;
  /** Continue an existing task (message/stream only). */
  taskId?: string;
}

/** JSON-RPC 2.0 client for the A2A protocol. */
export class A2AClient {
  constructor(private senderCard: AgentCard) {}

  // ── A2A standard methods ──────────────────────────────────────────────

  /** Send a message to a remote agent, creating or continuing a task. */
  async sendMessage(agentUrl: string, parts: Part[], contextId?: string): Promise<Task> {
    const message = this.buildMessage(parts, contextId);
    const params: MessageSendParams = { message };
    const response = await this.rpc(agentUrl, 'message/send', params);

    if (response.error) {
      throw new Error(`message/send failed: ${response.error.message}`);
    }

    return normalizeTask(response.result);
  }

  /**
   * Send a message over message/stream and iterate the Server-Sent Events
   * the agent emits: the opening Task (or a single direct Message), then
   * status and artifact updates until the task reaches a terminal state and
   * the agent closes the stream. Events are normalized to the 0.3 shapes
   * (`kind: 'task' | 'message' | 'status-update' | 'artifact-update'`)
   * whether the agent speaks 0.3 or wraps them in a 1.0 StreamResponse.
   *
   * Throws when the agent answers with a JSON-RPC error, including
   * UnsupportedOperationError from agents whose card declares
   * `capabilities.streaming: false`; check the card first when in doubt.
   */
  async *sendMessageStream(
    agentUrl: string,
    parts: Part[],
    contextId?: string,
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const message = this.buildMessage(parts, contextId);
    if (options.taskId) message.taskId = options.taskId;
    const params: MessageSendParams = { message };
    yield* this.stream(agentUrl, 'message/stream', params, options.signal);
  }

  /**
   * Reattach to a running task's stream (tasks/resubscribe). The agent replays
   * the current Task snapshot and then streams updates until the task ends.
   * Terminal tasks are refused by the agent with UnsupportedOperationError.
   */
  async *resubscribe(
    agentUrl: string,
    taskId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const params: TaskIdParams = { id: taskId };
    yield* this.stream(agentUrl, 'tasks/resubscribe', params, options.signal);
  }

  /** Get a task by ID from a remote agent. */
  async getTask(agentUrl: string, taskId: string): Promise<Task> {
    const params: TaskQueryParams = { id: taskId };
    const response = await this.rpc(agentUrl, 'tasks/get', params);

    if (response.error) {
      throw new Error(`tasks/get failed: ${response.error.message}`);
    }

    return normalizeTask(response.result);
  }

  /** Cancel a task on a remote agent. */
  async cancelTask(agentUrl: string, taskId: string): Promise<Task> {
    const params: TaskIdParams = { id: taskId };
    const response = await this.rpc(agentUrl, 'tasks/cancel', params);

    if (response.error) {
      throw new Error(`tasks/cancel failed: ${response.error.message}`);
    }

    return normalizeTask(response.result);
  }

  /** List tasks on a remote agent (newest first) with optional filters and paging. */
  async listTasks(agentUrl: string, params: ListTasksParams = {}): Promise<ListTasksResult> {
    return this.call<ListTasksResult>(agentUrl, 'tasks/list', params);
  }

  /** Register a webhook that receives updates for a task. Returns the stored config with its id. */
  async setPushNotificationConfig(
    agentUrl: string,
    taskId: string,
    config: PushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    const params: TaskPushNotificationConfig = { taskId, pushNotificationConfig: config };
    return this.call<TaskPushNotificationConfig>(agentUrl, 'tasks/pushNotificationConfig/set', params);
  }

  /** Fetch a task's push notification config (the first one when configId is omitted). */
  async getPushNotificationConfig(
    agentUrl: string,
    taskId: string,
    configId?: string,
  ): Promise<TaskPushNotificationConfig> {
    const params: GetTaskPushNotificationConfigParams = { id: taskId, pushNotificationConfigId: configId };
    return this.call<TaskPushNotificationConfig>(agentUrl, 'tasks/pushNotificationConfig/get', params);
  }

  /** List every push notification config registered for a task. */
  async listPushNotificationConfigs(agentUrl: string, taskId: string): Promise<TaskPushNotificationConfig[]> {
    const params: ListTaskPushNotificationConfigParams = { id: taskId };
    return this.call<TaskPushNotificationConfig[]>(agentUrl, 'tasks/pushNotificationConfig/list', params);
  }

  /** Remove a push notification config from a task. */
  async deletePushNotificationConfig(agentUrl: string, taskId: string, configId: string): Promise<void> {
    const params: DeleteTaskPushNotificationConfigParams = { id: taskId, pushNotificationConfigId: configId };
    await this.call<null>(agentUrl, 'tasks/pushNotificationConfig/delete', params);
  }

  /**
   * Discover a remote agent by fetching its agent card.
   *
   * Probes the A2A v1.0 well-known path (`/.well-known/agent-card.json`)
   * and falls back to the pre-1.0 path (`/.well-known/agent.json`). The
   * returned card is normalized to the v1.0 structure.
   *
   * @throws AgentCardDiscoveryError when neither path serves a card.
   */
  async discover(agentUrl: string): Promise<AgentCard> {
    return fetchAgentCard(agentUrl, { timeoutMs: DEFAULT_TIMEOUT_MS });
  }

  /** Ping a remote agent. */
  async ping(agentUrl: string): Promise<boolean> {
    try {
      const url = agentUrl.replace(/\/+$/, '');
      const res = await fetch(`${url}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── YouAgent convenience methods (use DataPart within A2A messages) ───

  /** Send a follow request via A2A message/send with a DataPart. */
  async follow(agentUrl: string): Promise<Task> {
    if (!isYouAgent(this.senderCard)) {
      throw new Error('Only YouAgent cards can send follow requests');
    }
    const followData: YouAgentFollowData = {
      type: 'youagent/follow',
      agentId: this.senderCard.youagent.id,
      handle: this.senderCard.youagent.handle,
    };
    const dataPart: DataPart = {
      kind: 'data',
      data: followData as unknown as Record<string, unknown>,
    };
    return this.sendMessage(agentUrl, [dataPart]);
  }

  /** Send an unfollow notification. */
  async unfollow(agentUrl: string, agentId: string): Promise<Task> {
    if (!isYouAgent(this.senderCard)) {
      throw new Error('Only YouAgent cards can send unfollow requests');
    }
    const unfollowData: YouAgentUnfollowData = {
      type: 'youagent/unfollow',
      agentId,
    };
    const dataPart: DataPart = {
      kind: 'data',
      data: unfollowData as unknown as Record<string, unknown>,
    };
    return this.sendMessage(agentUrl, [dataPart]);
  }

  /** Request posts from a remote agent. */
  async getPosts(agentUrl: string, since?: string, limit?: number): Promise<Post[]> {
    const requestData: YouAgentPostsRequestData = {
      type: 'youagent/posts-request',
      since,
      limit,
    };
    const dataPart: DataPart = {
      kind: 'data',
      data: requestData as unknown as Record<string, unknown>,
    };
    const task = await this.sendMessage(agentUrl, [dataPart]);

    // Extract posts from task artifacts
    if (task.artifacts) {
      for (const artifact of task.artifacts) {
        for (const part of artifact.parts) {
          if (part.kind === 'data') {
            const payload = part.data as unknown as YouAgentPostsResponseData;
            if (payload.type === 'youagent/posts-response') {
              return payload.posts;
            }
          }
        }
      }
    }

    return [];
  }

  /** Send a text message to another agent. */
  async sendText(agentUrl: string, text: string, contextId?: string): Promise<Task> {
    const textPart: TextPart = { kind: 'text', text };
    return this.sendMessage(agentUrl, [textPart], contextId);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /** rpc() plus error unwrapping, for methods that return a typed result. */
  private async call<T>(agentUrl: string, method: string, params: unknown): Promise<T> {
    const response = await this.rpc(agentUrl, method, params);
    if (response.error) {
      throw new Error(`${method} failed: ${response.error.message}`);
    }
    return response.result as T;
  }

  /**
   * POST a JSON-RPC request and iterate the SSE frames of the response. A
   * non-SSE response is read as a single JSON-RPC reply (an error, or an
   * agent that answered a stream request unary).
   */
  private async *stream(
    agentUrl: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const request = this.buildJsonRpc(method, params);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    // The connection must open within the timeout; the stream itself may run as long as the task.
    const connectTimer = setTimeout(abort, DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    try {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        const response = (await res.json()) as JsonRpcResponse;
        if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
        yield normalizeStreamEvent(response.result);
        return;
      }
      if (!res.body) throw new Error(`${method} failed: empty response body`);

      for await (const data of readSseData(res.body)) {
        const response = JSON.parse(data) as JsonRpcResponse;
        if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
        yield normalizeStreamEvent(response.result);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      // Consumer stopped early (break/return): close the connection.
      controller.abort();
    }
  }

  private async rpc(agentUrl: string, method: string, params: unknown): Promise<JsonRpcResponse> {
    const request = this.buildJsonRpc(method, params);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
          const res = await fetch(agentUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}: ${text}`);
          }

          return (await res.json()) as JsonRpcResponse;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }

  private buildMessage(parts: Part[], contextId?: string): Message {
    const { id, handle } = getAgentIdentifier(this.senderCard);
    return {
      role: 'user',
      parts,
      messageId: uuidv4(),
      contextId: contextId ?? uuidv4(),
      metadata: {
        senderId: id,
        senderHandle: handle,
      },
    };
  }

  private buildJsonRpc(method: string, params: unknown): JsonRpcRequest {
    return {
      jsonrpc: '2.0',
      id: uuidv4(),
      method,
      params,
    };
  }
}

/**
 * Iterate the `data` payloads of a Server-Sent Events byte stream. Frames are
 * separated by a blank line; multi-line `data:` fields are joined with `\n`
 * and comment lines (starting with `:`) are ignored, per the WHATWG
 * EventSource parsing rules. `event`, `id` and `retry` fields are skipped
 * because A2A carries everything in `data`.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): string | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n');
    dataLines = [];
    return data;
  };

  const consumeLine = (line: string): string | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1));
        const data = consumeLine(line);
        if (data !== undefined) yield data;
      }
      if (done) break;
    }
    // A final frame without a trailing blank line still counts.
    if (buffer !== '') consumeLine(buffer);
    const tail = flush();
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}
