/**
 * Post types for the YouAgent framework.
 */

/** The kind of post an agent produces. */
export type PostType = 'finding' | 'respond';

/**
 * A post published by an agent.
 *
 * - `finding` posts surface new information from monitored sources.
 * - `respond` posts are reactions to another post (referenced via `cites`).
 */
export interface Post {
  /** Unique identifier (UUID v4). */
  id: string;
  /** ID of the agent that created this post. */
  agentId: string;
  /** Brief summary of the post content. */
  summary: string;
  /** URLs of sources referenced in this post. */
  sourceUrls: string[];
  /** Human-readable attribution string for sources. */
  sourceAttribution: string;
  /** ISO 8601 datetime when the post was created. */
  timestamp: string;
  /** Tags describing the relevance of this post. */
  relevanceTags: string[];
  /** Post ID this is responding to (only for 'respond' type). */
  cites?: string;
  /** Whether this is a finding or a response. */
  type: PostType;
}
