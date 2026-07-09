// ---------------------------------------------------------------------------
// NetworkSearchClient — search via the For You network's metered proxy
// ---------------------------------------------------------------------------
//
// Registered agents can search through the network's shared You.com key at
// GET /api/v1/search, authenticated with their registration bearer key. This
// lets a first run work with no You.com key of its own. The proxy is metered
// (daily per-agent and network-wide caps), so a 429 here means the cap is
// exhausted for the day — it is not retried.

import { ApiError } from './types.js';
import type { SearchOptions, SearchResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const SEARCH_PATH = '/api/v1/search';

/** Retry delay schedule in milliseconds (1 s, 2 s, 4 s, …). */
function retryDelay(attempt: number): number {
  return 1_000 * Math.pow(2, attempt);
}

/** Configuration for the {@link NetworkSearchClient}. */
export interface NetworkSearchConfig {
  /** Registry base URL (default: https://for.you.com). */
  baseUrl?: string;
  /** Bearer key (`ya_...`) issued when the agent registered. */
  apiKey: string;
  /** Request timeout in milliseconds (default: 30 000). */
  timeout?: number;
  /** Retry attempts for transient failures (default: 3). */
  retries?: number;
}

/** Wire shape of the proxy's search response. */
interface NetworkSearchResponse {
  results?: Array<{ title?: string; url?: string; description?: string }>;
}

/**
 * A search client backed by the For You network's metered search proxy
 * instead of a personal You.com API key.
 *
 * Implements the same `search()` surface as {@link YouSearchClient}, so the
 * daemon and CLI can use either interchangeably. Research, RAG answers, and
 * content extraction are not available through the proxy.
 */
export class NetworkSearchClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: NetworkSearchConfig) {
    if (!config.apiKey) {
      throw new Error(
        'NetworkSearchClient requires the bearer key issued on registration.',
      );
    }
    this.baseUrl = (config.baseUrl ?? 'https://for.you.com').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.retries ?? DEFAULT_RETRIES;
  }

  /**
   * Search the web through the network's proxy.
   *
   * @param query  The search query string.
   * @param options  `numResults` is honoured (the proxy clamps it to 1–10);
   *                 other options are not supported by the proxy.
   * @returns An array of search results.
   */
  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options?.numResults !== undefined) {
      params.set('count', String(options.numResults));
    }

    const data = await this.request(`${SEARCH_PATH}?${params.toString()}`);

    return (data.results ?? [])
      .filter((hit) => hit.url && hit.title)
      .map((hit) => ({
        title: hit.title ?? '',
        url: hit.url ?? '',
        snippet: hit.description ?? '',
        description: hit.description ?? '',
        thumbnails: [],
      }));
  }

  /** No resources to release; present for parity with YouSearchClient. */
  dispose(): void {}

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async request(path: string): Promise<NetworkSearchResponse> {
    let lastError: ApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (response.ok) {
          return (await response.json()) as NetworkSearchResponse;
        }

        const body = await response.text().catch(() => '');

        // The proxy's caps are daily; retrying a 429 cannot succeed.
        if (response.status === 429) {
          throw new ApiError(
            'Network search cap reached for today. Set YDC_API_KEY to search with your own You.com key.',
            429,
            false,
          );
        }

        const retryable = response.status >= 500;
        lastError = new ApiError(
          `Network search error ${response.status}: ${body || response.statusText}`,
          response.status,
          retryable,
        );

        if (!retryable || attempt === this.maxRetries) {
          throw lastError;
        }
      } catch (error) {
        if (error instanceof ApiError) {
          if (!error.retryable || attempt === this.maxRetries) {
            throw error;
          }
          lastError = error;
        } else {
          const isAbort =
            error instanceof DOMException && error.name === 'AbortError';
          const message =
            error instanceof Error ? error.message : String(error);

          lastError = new ApiError(
            isAbort
              ? `Request timed out after ${this.timeoutMs}ms`
              : `Network error: ${message}`,
            0,
            true,
          );

          if (attempt === this.maxRetries) {
            throw lastError;
          }
        }
      } finally {
        clearTimeout(timer);
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }

    throw lastError ?? new ApiError('Unknown error', 0, false);
  }
}
