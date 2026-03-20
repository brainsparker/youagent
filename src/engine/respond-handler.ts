// ---------------------------------------------------------------------------
// Respond Handler — Deeper investigation on an existing post
// ---------------------------------------------------------------------------

import type { Post } from '../types/post.js';
import type { PostRepo } from '../storage/post-repo.js';
import type { YouSearchClient } from '../client/you-client.js';
import type { SearchResult } from '../client/types.js';
import { FindingExtractorImpl, type Finding } from './finding-extractor.js';
import { PostPublisher } from './post-publisher.js';

/**
 * Handles the "Respond" action: takes an existing post, performs deeper
 * research, and publishes a new respond-type post that cites the original.
 */
export class RespondHandler {
  constructor(
    private searchClient: YouSearchClient,
    private extractor: FindingExtractorImpl,
    private publisher: PostPublisher,
    private postRepo: PostRepo,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Execute a Respond on a post — deeper investigation.
   *
   * 1. Load the original post from PostRepo.
   * 2. Generate focused search queries from the post's summary and tags.
   * 3. Execute searches via YouSearchClient (research mode).
   * 4. Extract findings via FindingExtractorImpl.
   * 5. Pick the best finding (highest relevance overlap with original post).
   * 6. Publish as a Respond post via PostPublisher.publishRespond().
   * 7. Return the new Respond post.
   */
  async respond(postId: string): Promise<Post> {
    // 1. Load the original post.
    const originalPost = this.postRepo.findById(postId);
    if (!originalPost) {
      throw new Error(`Post not found: ${postId}`);
    }

    // 2. Generate focused search queries.
    const queries = this.generateRespondQueries(originalPost);

    // 3. Execute research queries and collect search results.
    const allResults: SearchResult[] = [];
    for (const query of queries) {
      const researchResult = await this.searchClient.research(query);
      // Convert research sources into SearchResult shape for the extractor.
      const results: SearchResult[] = researchResult.sources.map((source) => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        description: '',
        thumbnails: [],
      }));
      allResults.push(...results);
    }

    if (allResults.length === 0) {
      throw new Error(`No research results found for post: ${postId}`);
    }

    // 4. Extract findings from the collected results.
    const interest = originalPost.relevanceTags[0] ?? originalPost.summary;
    const findings = await this.extractor.extract(allResults, interest);

    if (findings.length === 0) {
      throw new Error(`No findings extracted for post: ${postId}`);
    }

    // 5. Pick the best finding — highest relevance tag overlap with original.
    const bestFinding = this.pickBestFinding(findings, originalPost);

    // 6. Publish as a Respond post.
    const respondPost = await this.publisher.publishRespond(
      bestFinding,
      originalPost.id,
    );

    // 7. Return the new Respond post.
    return respondPost;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Generate 3–5 focused search queries from a post's summary and relevance
   * tags.
   *
   * Strategy:
   * - Extract key phrases (multi-word) from the summary.
   * - Combine with relevance tags.
   * - Build queries like "{key phrase} analysis", "{tag1} {tag2} latest
   *   research", and "{summary excerpt} deeper investigation".
   */
  private generateRespondQueries(post: Post): string[] {
    const phrases = this.extractKeyPhrases(post.summary);
    const tags = post.relevanceTags.slice(0, 3);
    const queries: string[] = [];

    // Query from top key phrase + "analysis"
    if (phrases.length > 0) {
      queries.push(`${phrases[0]} analysis`);
    }

    // Query from tag combination + "latest research"
    if (tags.length >= 2) {
      queries.push(`${tags[0]} ${tags[1]} latest research`);
    } else if (tags.length === 1) {
      queries.push(`${tags[0]} latest research`);
    }

    // Query from summary excerpt + "deeper investigation"
    const excerpt = post.summary.split(/[.!?]/)[0]?.trim();
    if (excerpt && excerpt.length > 10) {
      queries.push(`${excerpt} deeper investigation`);
    }

    // Query from second key phrase if available
    if (phrases.length > 1) {
      queries.push(`${phrases[1]} implications`);
    }

    // Query combining a phrase with a tag
    if (phrases.length > 0 && tags.length > 0) {
      queries.push(`${phrases[0]} ${tags[0]} developments`);
    }

    // Return 3–5 queries.
    return queries.slice(0, 5);
  }

  /**
   * Extract the top 3–5 multi-word key phrases from text.
   *
   * Uses a simple bigram extraction approach: pairs of consecutive
   * non-stopword words are treated as key phrases.
   */
  private extractKeyPhrases(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const stopwords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
      'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has',
      'have', 'been', 'being', 'with', 'this', 'that', 'from',
      'they', 'were', 'will', 'would', 'there', 'their', 'what',
      'about', 'which', 'when', 'make', 'like', 'just', 'over',
      'such', 'into', 'also', 'more', 'other', 'than', 'then',
      'some', 'very', 'could', 'should',
    ]);

    // Build bigrams of non-stopword words.
    const contentWords = words.filter((w) => !stopwords.has(w));
    const phrases: string[] = [];

    for (let i = 0; i < contentWords.length - 1; i++) {
      phrases.push(`${contentWords[i]} ${contentWords[i + 1]}`);
    }

    // Deduplicate and return top 3–5.
    const unique = [...new Set(phrases)];
    return unique.slice(0, 5);
  }

  /**
   * Pick the finding with the highest relevance tag overlap with the
   * original post.
   */
  private pickBestFinding(findings: Finding[], originalPost: Post): Finding {
    const originalTags = new Set(
      originalPost.relevanceTags.map((t) => t.toLowerCase()),
    );

    let bestFinding = findings[0]!;
    let bestScore = -1;

    for (const finding of findings) {
      let score = 0;
      for (const tag of finding.relevanceTags) {
        if (originalTags.has(tag.toLowerCase())) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestFinding = finding;
      }
    }

    return bestFinding;
  }
}
