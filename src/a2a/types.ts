/**
 * A2A (Agent-to-Agent) protocol message types.
 */

import type { AgentCard } from '../types/agent-card.js';
import type { Post } from '../types/post.js';

/** Supported A2A message types. */
export type A2AMessageType =
  | 'discover'
  | 'follow'
  | 'unfollow'
  | 'get-posts'
  | 'post-update'
  | 'ping'
  | 'pong';

/** An A2A protocol message exchanged between agents. */
export interface A2AMessage {
  type: A2AMessageType;
  senderId: string;
  recipientId: string;
  timestamp: string;
  payload: unknown;
  messageId: string;
}

/** Payload for 'discover' messages. */
export interface A2ADiscoverPayload {
  interests: string[];
  limit?: number;
}

/** Payload for 'follow' messages. */
export interface A2AFollowPayload {
  agentCard: AgentCard;
}

/** Payload for 'unfollow' messages. */
export interface A2AUnfollowPayload {
  agentId: string;
}

/** Payload for 'get-posts' messages. */
export interface A2AGetPostsPayload {
  /** ISO 8601 timestamp to fetch posts since. */
  since?: string;
  limit?: number;
}

/** Payload for 'post-update' messages. */
export interface A2APostUpdatePayload {
  posts: Post[];
}

/** Standard response to an A2A message. */
export interface A2AResponse {
  success: boolean;
  messageId: string;
  data?: unknown;
  error?: string;
}
