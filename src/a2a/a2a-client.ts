/**
 * A2A client — JSON-RPC 2.0 based agent-to-agent communication.
 *
 * Every request carries the `A2A-Version` service parameter (spec 3.6.1).
 * By default the client speaks the 0.3 dialect youagent stores natively;
 * pass `{ protocolVersion: '1.0' }` to talk to servers that only serve the
 * v1.0 wire format (PascalCase methods, `ROLE_*`, oneof parts, wrapped
 * `SendMessage` results). Responses in either dialect are normalized to the
 * internal shape on ingest.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import { isYouAgent, getAgentIdentifier } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { normalizeTask } from './compat.js';
import { fetchAgentCard } from './discovery.js';
import {
  A2A_DEFAULT_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  fromV1PushConfig,
  fromV1PushConfigList,
  fromV1SendMessageResult,
  toV1Message,
  toV1PushParams,
  type A2AProtocolVersion,
} from './version.js';
import {
  A2A_V1_METHOD_ALIASES,
  type JsonRpcRequest,
  type JsonRpcResponse,
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
  YouAgentFollowData,
  YouAgentUnfollowData,
  YouAgentPostsRequestData,
  YouAgentPostsResponseData,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** 0.3 method name to the 1.0 PascalCase name sent when speaking 1.0. */
const V1_METHOD_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(A2A_V1_METHOD_ALIASES).map(([v1, legacy]) => [legacy, v1]),
);

/** Options for `A2AClient`. */
export interface A2AClientOptions {
  /**
   * Wire dialect to speak: `0.3` (default) or `1.0`. Set `1.0` for servers
   * that only implement the v1.0 serialization, such as stock `@a2a-js/sdk`
   * 1.x without legacy compatibility enabled.
   */
  protocolVersion?: A2AProtocolVersion;
}

/** JSON-RPC 2.0 client for the A2A protocol. */
export class A2AClient {
  readonly protocolVersion: A2AProtocolVersion;

  constructor(
    private senderCard: AgentCard,
    options: A2AClientOptions = {},
  ) {
    this.protocolVersion = options.protocolVersion ?? A2A_DEFAULT_PROTOCOL_VERSION;
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

    // 1.0 wraps the result as SendMessageResponse ({ task } | { message }).
    return normalizeTask(fromV1SendMessageResult(response.result));
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
    const result = await this.call<ListTasksResult>(agentUrl, 'tasks/list', params);
    return { ...result, tasks: (result.tasks ?? []).map(normalizeTask) };
  }

  /** Register a webhook that receives updates for a task. Returns the stored config with its id. */
  async setPushNotificationConfig(
    agentUrl: string,
    taskId: string,
    config: PushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    const params: TaskPushNotificationConfig = { taskId, pushNotificationConfig: config };
    const result = await this.call<unknown>(agentUrl, 'tasks/pushNotificationConfig/set', params);
    return fromV1PushConfig(result);
  }

  /** Fetch a task's push notification config (the first one when configId is omitted). */
  async getPushNotificationConfig(
    agentUrl: string,
    taskId: string,
    configId?: string,
  ): Promise<TaskPushNotificationConfig> {
    const params: GetTaskPushNotificationConfigParams = { id: taskId, pushNotificationConfigId: configId };
    const result = await this.call<unknown>(agentUrl, 'tasks/pushNotificationConfig/get', params);
    return fromV1PushConfig(result);
  }

  /** List every push notification config registered for a task. */
  async listPushNotificationConfigs(agentUrl: string, taskId: string): Promise<TaskPushNotificationConfig[]> {
    const params: ListTaskPushNotificationConfigParams = { id: taskId };
    const result = await this.call<unknown>(agentUrl, 'tasks/pushNotificationConfig/list', params);
    return fromV1PushConfigList(result);
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

  private async rpc(agentUrl: string, method: string, params: unknown): Promise<JsonRpcResponse> {
    const request = this.buildJsonRpc(method, params);
    const headers = { 'Content-Type': 'application/json', [A2A_VERSION_HEADER]: this.protocolVersion };
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
          const res = await fetch(agentUrl, {
            method: 'POST',
            headers,
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

  /**
   * Build the JSON-RPC envelope in the client's dialect. In 1.0 the method
   * takes its PascalCase name and an outgoing message is projected onto the
   * v1.0 shape (`ROLE_USER`, oneof parts, no `kind`).
   */
  private buildJsonRpc(method: string, params: unknown): JsonRpcRequest {
    if (this.protocolVersion !== '1.0') {
      return { jsonrpc: '2.0', id: uuidv4(), method, params };
    }
    let v1Params = toV1PushParams(method, params);
    if (method === 'message/send' && params && typeof params === 'object') {
      const { message, ...rest } = params as MessageSendParams;
      v1Params = { ...rest, message: toV1Message(message) };
    }
    return {
      jsonrpc: '2.0',
      id: uuidv4(),
      method: V1_METHOD_NAMES[method] ?? method,
      params: v1Params,
    };
  }
}
