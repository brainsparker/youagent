/**
 * A2A client — JSON-RPC 2.0 based agent-to-agent communication.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import { isYouAgent, getAgentIdentifier } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { normalizeTask } from './compat.js';
import { fetchAgentCard } from './discovery.js';
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
  YouAgentFollowData,
  YouAgentUnfollowData,
  YouAgentPostsRequestData,
  YouAgentPostsResponseData,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Credentials the client presents to a remote agent. */
export interface A2AClientCredentials {
  /** Sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Sent in `apiKeyHeader` (default `X-API-Key`). */
  apiKey?: string;
  /** Header for `apiKey`. Defaults to `X-API-Key`. */
  apiKeyHeader?: string;
  /** Extra headers, for schemes the two fields above do not cover. */
  headers?: Record<string, string>;
}

/** Options for `A2AClient`. */
export interface A2AClientOptions {
  /** Credentials sent to every agent this client talks to. */
  credentials?: A2AClientCredentials;
  /**
   * Per-agent credentials, looked up by the exact `agentUrl` passed to a
   * call. Takes precedence over `credentials` when it returns a value.
   */
  credentialsFor?: (agentUrl: string) => A2AClientCredentials | undefined;
  /** fetch implementation override (tests, custom agents). */
  fetch?: typeof fetch;
}

/**
 * Thrown when a remote agent answers a JSON-RPC call with HTTP 401 or 403:
 * the agent requires authentication this client did not (or could not)
 * satisfy. `challenge` carries the server's `WWW-Authenticate` header, which
 * names the schemes it accepts; the agent card's `securitySchemes` has the
 * details.
 */
export class A2AAuthenticationError extends Error {
  readonly name = 'A2AAuthenticationError';
  constructor(
    readonly agentUrl: string,
    readonly status: number,
    readonly challenge: string | undefined,
    body: string,
  ) {
    super(
      `${agentUrl} answered HTTP ${status}: ${
        status === 401 ? 'authentication required' : 'not authorized'
      }${challenge ? ` (WWW-Authenticate: ${challenge})` : ''}${body ? ` ${body}` : ''}`,
    );
  }
}

/** JSON-RPC 2.0 client for the A2A protocol. */
export class A2AClient {
  private readonly options: A2AClientOptions;

  constructor(
    private senderCard: AgentCard,
    options: A2AClientOptions = {},
  ) {
    this.options = options;
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

  /** Headers for a call to `agentUrl`: content type plus any configured credentials. */
  private requestHeaders(agentUrl: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const creds = this.options.credentialsFor?.(agentUrl) ?? this.options.credentials;
    if (!creds) return headers;
    if (creds.headers) Object.assign(headers, creds.headers);
    if (creds.apiKey) headers[creds.apiKeyHeader ?? 'X-API-Key'] = creds.apiKey;
    if (creds.bearerToken) headers['Authorization'] = `Bearer ${creds.bearerToken}`;
    return headers;
  }

  private async rpc(agentUrl: string, method: string, params: unknown): Promise<JsonRpcResponse> {
    const request = this.buildJsonRpc(method, params);
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
          const res = await fetchImpl(agentUrl, {
            method: 'POST',
            headers: this.requestHeaders(agentUrl),
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          if (res.status === 401 || res.status === 403) {
            // Retrying with the same credentials cannot succeed; surface
            // the challenge so the caller can pick up the right ones.
            const text = await res.text().catch(() => '');
            throw new A2AAuthenticationError(
              agentUrl,
              res.status,
              res.headers.get('www-authenticate') ?? undefined,
              text,
            );
          }

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}: ${text}`);
          }

          return (await res.json()) as JsonRpcResponse;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (err instanceof A2AAuthenticationError) throw err;
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
