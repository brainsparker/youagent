/**
 * A2A client — JSON-RPC 2.0 based agent-to-agent communication.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import { isYouAgent, getAgentIdentifier } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { normalizeArtifact, normalizeMessage, normalizeTask } from './compat.js';
import { fetchAgentCard } from './discovery.js';
import { parseSseStream } from './sse.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  Message,
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
  TaskResubscribeParams,
  StreamEvent,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
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
}

/** JSON-RPC 2.0 client for the A2A protocol. */
export class A2AClient {
  constructor(private senderCard: AgentCard) {}

  // ── A2A streaming methods ─────────────────────────────────────────────

  /**
   * Send a message with message/stream and yield every event the remote
   * agent emits: the Task first, then TaskStatusUpdateEvent and
   * TaskArtifactUpdateEvent objects until a `final: true` status update
   * closes the stream. Throws when the agent answers with a JSON-RPC error
   * (for example UnsupportedOperation when it does not stream).
   */
  async *sendStreamingMessage(
    agentUrl: string,
    parts: Part[],
    contextId?: string,
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const message = this.buildMessage(parts, contextId);
    const params: MessageSendParams = { message };
    yield* this.stream(agentUrl, 'message/stream', params, options);
  }

  /** Stream a text message; see sendStreamingMessage. */
  streamText(agentUrl: string, text: string, contextId?: string, options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    const textPart: TextPart = { kind: 'text', text };
    return this.sendStreamingMessage(agentUrl, [textPart], contextId, options);
  }

  /**
   * Reattach to a running task with tasks/resubscribe. Yields the current
   * Task, then updates until the task reaches a terminal state.
   */
  async *subscribeToTask(agentUrl: string, taskId: string, options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    const params: TaskResubscribeParams = { id: taskId };
    yield* this.stream(agentUrl, 'tasks/resubscribe', params, options);
  }

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
   * POST a JSON-RPC request and yield the stream events carried by the SSE
   * response. A JSON (non-SSE) response is the agent's error reply and is
   * thrown. Each SSE event is a JSON-RPC response whose `result` is the
   * event; tasks and messages are normalized the way sendMessage does.
   */
  private async *stream(agentUrl: string, method: string, params: unknown, options: StreamOptions): AsyncGenerator<StreamEvent> {
    const request = this.buildJsonRpc(method, params);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    try {
      const res = await fetch(agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        const response = (await res.json()) as JsonRpcResponse;
        if (response.error) {
          throw new Error(`${method} failed: ${response.error.message}`);
        }
        throw new Error(`${method} failed: expected an event stream, got ${contentType || 'no content type'}`);
      }
      if (!res.body) {
        throw new Error(`${method} failed: empty response body`);
      }

      for await (const sse of parseSseStream(res.body)) {
        let response: JsonRpcResponse;
        try {
          response = JSON.parse(sse.data) as JsonRpcResponse;
        } catch {
          throw new Error(`${method} failed: stream event is not JSON`);
        }
        if (response.error) {
          throw new Error(`${method} failed: ${response.error.message}`);
        }
        yield normalizeStreamEvent(response.result);
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
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

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize one streamed result the way sendMessage normalizes a Task:
 * parts arriving with the legacy `type` discriminator are rewritten to
 * `kind`. Unknown shapes are returned as-is so a newer peer cannot break
 * the stream.
 */
export function normalizeStreamEvent(result: unknown): StreamEvent {
  if (!result || typeof result !== 'object') return result as StreamEvent;
  const record = result as Record<string, unknown>;
  switch (record.kind) {
    case 'status-update': {
      const event = { ...(record as unknown as TaskStatusUpdateEvent) };
      if (event.status?.message) {
        event.status = { ...event.status, message: normalizeMessage(event.status.message) };
      }
      return event;
    }
    case 'artifact-update': {
      const event = record as unknown as TaskArtifactUpdateEvent;
      return { ...event, artifact: normalizeArtifact(event.artifact) };
    }
    case 'message':
      return normalizeMessage(record);
    case 'task':
      return normalizeTask(record);
    default:
      // Pre-0.2 peers omit `kind`; a Task is the only unlabeled shape youagent emits.
      if (typeof record.id === 'string' && record.status) return normalizeTask(record);
      return result as StreamEvent;
  }
}
