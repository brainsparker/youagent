/**
 * A2A client — JSON-RPC 2.0 based agent-to-agent communication.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
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
  YouAgentFollowData,
  YouAgentUnfollowData,
  YouAgentPostsRequestData,
  YouAgentPostsResponseData,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

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

    return response.result as Task;
  }

  /** Get a task by ID from a remote agent. */
  async getTask(agentUrl: string, taskId: string): Promise<Task> {
    const params: TaskQueryParams = { id: taskId };
    const response = await this.rpc(agentUrl, 'tasks/get', params);

    if (response.error) {
      throw new Error(`tasks/get failed: ${response.error.message}`);
    }

    return response.result as Task;
  }

  /** Cancel a task on a remote agent. */
  async cancelTask(agentUrl: string, taskId: string): Promise<Task> {
    const params: TaskIdParams = { id: taskId };
    const response = await this.rpc(agentUrl, 'tasks/cancel', params);

    if (response.error) {
      throw new Error(`tasks/cancel failed: ${response.error.message}`);
    }

    return response.result as Task;
  }

  /** Discover a remote agent by fetching its agent card. */
  async discover(agentUrl: string): Promise<AgentCard> {
    const url = agentUrl.replace(/\/+$/, '');
    const res = await fetch(`${url}/.well-known/agent.json`);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discovery failed (HTTP ${res.status}): ${text}`);
    }

    return (await res.json()) as AgentCard;
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
    const followData: YouAgentFollowData = {
      type: 'youagent/follow',
      agentId: this.senderCard.youagent.id,
      handle: this.senderCard.youagent.handle,
    };
    const dataPart: DataPart = {
      type: 'data',
      data: followData as unknown as Record<string, unknown>,
    };
    return this.sendMessage(agentUrl, [dataPart]);
  }

  /** Send an unfollow notification. */
  async unfollow(agentUrl: string, agentId: string): Promise<Task> {
    const unfollowData: YouAgentUnfollowData = {
      type: 'youagent/unfollow',
      agentId,
    };
    const dataPart: DataPart = {
      type: 'data',
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
      type: 'data',
      data: requestData as unknown as Record<string, unknown>,
    };
    const task = await this.sendMessage(agentUrl, [dataPart]);

    // Extract posts from task artifacts
    if (task.artifacts) {
      for (const artifact of task.artifacts) {
        for (const part of artifact.parts) {
          if (part.type === 'data') {
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
    const textPart: TextPart = { type: 'text', text };
    return this.sendMessage(agentUrl, [textPart], contextId);
  }

  // ── Private helpers ───────────────────────────────────────────────────

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
    return {
      role: 'user',
      parts,
      messageId: uuidv4(),
      contextId: contextId ?? uuidv4(),
      metadata: {
        senderId: this.senderCard.youagent.id,
        senderHandle: this.senderCard.youagent.handle,
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
