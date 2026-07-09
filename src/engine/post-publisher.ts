// ---------------------------------------------------------------------------
// Post Publishing — Convert findings to posts and persist them
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import type { Post } from '../types/post.js';
import type { PostRepo } from '../storage/post-repo.js';
import type { NetworkPusher } from '../registry/pusher.js';
import type { Finding } from './finding-extractor.js';

/** Default number of recent posts to check when deduplicating. */
const DEFAULT_RECENT_COUNT = 50;

/** Jaccard similarity threshold above which a finding is considered duplicate. */
const DUPLICATE_THRESHOLD = 0.5;

/**
 * Tokenise text into lower-case words, stripping punctuation.
 */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return new Set(words);
}

/**
 * Jaccard similarity between two strings based on their word sets.
 *
 * J(A, B) = |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Converts {@link Finding}s into {@link Post}s, deduplicates against recent
 * posts, and persists them via the {@link PostRepo}.
 *
 * When a {@link NetworkPusher} is provided, published posts are also pushed
 * to the network best-effort — a failed push never fails local publishing.
 */
export class PostPublisher {
  constructor(
    private postRepo: PostRepo,
    private agentId: string,
    private pusher?: NetworkPusher,
  ) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Convert an array of findings to posts and publish them.
   *
   * Each finding is checked against recent posts for duplicates before
   * publishing. Only non-duplicate findings are saved and returned.
   */
  async publishFindings(findings: Finding[]): Promise<Post[]> {
    const published: Post[] = [];

    for (const finding of findings) {
      const duplicate = await this.isDuplicate(finding);
      if (duplicate) continue;

      const post = this.findingToPost(finding, 'finding');
      this.postRepo.save(post);
      published.push(post);
    }

    await this.pushToNetwork(published);
    return published;
  }

  /**
   * Publish a single "respond" post that cites another post.
   *
   * @param finding  The finding to convert into a respond post.
   * @param citedPostId  The ID of the post being responded to.
   * @returns The newly created respond post.
   */
  async publishRespond(finding: Finding, citedPostId: string): Promise<Post> {
    const post = this.findingToPost(finding, 'respond', citedPostId);
    this.postRepo.save(post);
    await this.pushToNetwork([post]);
    return post;
  }

  /**
   * Check whether a finding is a duplicate of a recently published post.
   *
   * Loads the most recent posts for this agent and compares summaries
   * using Jaccard similarity on word sets. A similarity score at or above
   * {@link DUPLICATE_THRESHOLD} (0.5) marks the finding as duplicate.
   *
   * @param finding  The finding to check.
   * @param recentCount  Number of recent posts to compare against (default 50).
   * @returns `true` if the finding is considered a duplicate.
   */
  async isDuplicate(
    finding: Finding,
    recentCount: number = DEFAULT_RECENT_COUNT,
  ): Promise<boolean> {
    const recentPosts = this.postRepo.findByAgentId(
      this.agentId,
      recentCount,
    );

    for (const post of recentPosts) {
      const similarity = jaccardSimilarity(finding.summary, post.summary);
      if (similarity >= DUPLICATE_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Push posts to the network best-effort; log-and-continue on failure. */
  private async pushToNetwork(posts: Post[]): Promise<void> {
    if (!this.pusher || posts.length === 0) return;

    try {
      const result = await this.pusher.push(posts);
      console.log(
        `[PostPublisher] Pushed to network — ${result.accepted}/${result.received} accepted.`,
      );
    } catch (err) {
      console.error('[PostPublisher] Network push failed:', err);
    }
  }

  /**
   * Convert a {@link Finding} into a {@link Post}.
   */
  private findingToPost(
    finding: Finding,
    type: 'finding' | 'respond',
    cites?: string,
  ): Post {
    return {
      id: uuidv4(),
      agentId: this.agentId,
      summary: finding.summary,
      sourceUrls: [finding.sourceUrl],
      sourceAttribution: finding.sourceAttribution,
      timestamp: new Date().toISOString(),
      relevanceTags: finding.relevanceTags,
      type,
      ...(cites !== undefined ? { cites } : {}),
    };
  }
}
