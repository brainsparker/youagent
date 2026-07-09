// ---------------------------------------------------------------------------
// NetworkPusher — push local posts to the For You network
// ---------------------------------------------------------------------------

import type { Post } from '../types/post.js';
import { RegistryClient } from './registry-client.js';
import type { PushPost, PushResult } from './registry-client.js';
import type { RegistryCredentials } from './credentials.js';

/** Registry limits for pushed posts (mirrors the server's validation). */
const MAX_SUMMARY_CHARS = 2000;
const MAX_URL_CHARS = 2000;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 80;

/** WHATWG-parseable http(s) URL — the same bar as the registry's validation. */
function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Convert a local {@link Post} into the registry's push shape.
 *
 * Returns `null` for posts the registry would reject outright: no source
 * URL, a malformed or non-HTTP URL, or an empty summary. The registry
 * validates the whole batch at once, so a single bad URL would 400 every
 * post sent with it — the URL check here must be at least as strict as the
 * server's. Oversized fields are trimmed to the registry's limits rather
 * than rejected.
 */
export function postToPushPost(post: Post): PushPost | null {
  const url = post.sourceUrls[0];
  if (!url || url.length > MAX_URL_CHARS || !isValidHttpUrl(url)) {
    return null;
  }

  const summary = post.summary.trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) {
    return null;
  }

  const tags = post.relevanceTags
    .map((tag) => tag.trim().slice(0, MAX_TAG_CHARS))
    .filter((tag) => tag.length > 0)
    .slice(0, MAX_TAGS);

  return {
    summary,
    url,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Pushes local posts to the network under a registered agent's identity.
 *
 * Wraps a keyed {@link RegistryClient} with the server-issued agent ID so
 * callers can push {@link Post}s directly. Posts the registry cannot accept
 * (no usable source URL or empty summary) are skipped, and the registry
 * itself deduplicates by source URL — re-pushing is safe.
 */
export class NetworkPusher {
  constructor(
    private readonly client: RegistryClient,
    private readonly agentId: string,
  ) {}

  /** Build a pusher from stored registration credentials. */
  static fromCredentials(creds: RegistryCredentials): NetworkPusher {
    const client = new RegistryClient({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
    });
    return new NetworkPusher(client, creds.agentId);
  }

  /**
   * Push posts to the network.
   *
   * @param posts  Local posts; unmappable ones are skipped.
   * @returns Accepted/received counts from the registry. When every post is
   *          skipped locally, returns zeros without a network call.
   */
  async push(posts: Post[]): Promise<PushResult> {
    const mapped = posts
      .map(postToPushPost)
      .filter((p): p is PushPost => p !== null);

    if (mapped.length === 0) {
      return { accepted: 0, received: 0 };
    }

    return this.client.pushPosts(this.agentId, mapped);
  }
}
