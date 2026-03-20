/**
 * A2A client for sending messages to other agents.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import type {
  A2AFollowPayload,
  A2AGetPostsPayload,
  A2AMessage,
  A2APostUpdatePayload,
  A2AResponse,
  A2AUnfollowPayload,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Client for sending A2A messages to other agents. */
export class A2AClient {
  constructor(private senderCard: AgentCard) {}

  /** Send a follow request to another agent. */
  async follow(targetEndpoint: string, card: AgentCard): Promise<A2AResponse> {
    const payload: A2AFollowPayload = { agentCard: card };
    const message = this.buildMessage('follow', targetEndpoint, payload);
    return this.send(targetEndpoint, message);
  }

  /** Send an unfollow notification to another agent. */
  async unfollow(targetEndpoint: string, agentId: string): Promise<A2AResponse> {
    const payload: A2AUnfollowPayload = { agentId };
    const message = this.buildMessage('unfollow', targetEndpoint, payload);
    return this.send(targetEndpoint, message);
  }

  /** Request posts from another agent. */
  async getPosts(targetEndpoint: string, since?: string, limit?: number): Promise<Post[]> {
    const payload: A2AGetPostsPayload = { since, limit };
    const message = this.buildMessage('get-posts', targetEndpoint, payload);
    const response = await this.send(targetEndpoint, message);
    if (!response.success) {
      throw new Error(`getPosts failed: ${response.error ?? 'unknown error'}`);
    }
    const data = response.data as A2APostUpdatePayload | undefined;
    return data?.posts ?? [];
  }

  /** Ping an agent to check availability. */
  async ping(targetEndpoint: string): Promise<boolean> {
    try {
      const message = this.buildMessage('ping', targetEndpoint, null);
      const response = await this.send(targetEndpoint, message);
      return response.success;
    } catch {
      return false;
    }
  }

  /** Send a generic A2A message to a target endpoint. */
  async send(targetEndpoint: string, message: A2AMessage): Promise<A2AResponse> {
    return this.sendWithRetry(targetEndpoint, message, 1);
  }

  // ── private ──────────────────────────────────────────────

  private buildMessage(
    type: A2AMessage['type'],
    _targetEndpoint: string,
    payload: unknown,
  ): A2AMessage {
    return {
      type,
      senderId: this.senderCard.youagent.id,
      recipientId: '', // filled by the receiving server
      timestamp: new Date().toISOString(),
      payload,
      messageId: uuidv4(),
    };
  }

  private async sendWithRetry(
    targetEndpoint: string,
    message: A2AMessage,
    retries: number,
  ): Promise<A2AResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.doFetch(targetEndpoint, message);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }

  private async doFetch(targetEndpoint: string, message: A2AMessage): Promise<A2AResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(targetEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      return (await res.json()) as A2AResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}
