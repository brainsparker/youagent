// ---------------------------------------------------------------------------
// YouSearchClient — You.com YDC API Client
// ---------------------------------------------------------------------------

import { RateLimiter } from "./rate-limiter.js";
import {
  ApiError,
  type AnswerApiResponse,
  type AnswerOptions,
  type AnswerResult,
  type ContentsApiResponse,
  type ContentsOptions,
  type ContentsResult,
  type RawSearchHit,
  type ResearchApiResponse,
  type ResearchOptions,
  type ResearchResult,
  type SearchApiResponse,
  type SearchOptions,
  type SearchResult,
  type YouClientConfig,
} from "./types.js";

const DEFAULT_BASE_URL = "https://ydc-index.io";
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Retry delay schedule in milliseconds (1 s, 2 s, 4 s, …). */
function retryDelay(attempt: number): number {
  return 1_000 * Math.pow(2, attempt);
}

/**
 * A typed client for the You.com YDC API.
 *
 * Supports search, research, RAG answers, and content extraction with
 * built-in rate limiting, retries with exponential backoff, and request
 * timeouts via AbortController.
 */
export class YouSearchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(config: YouClientConfig) {
    if (!config.apiKey) {
      throw new Error("YouSearchClient requires an API key.");
    }

    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = config.retries ?? DEFAULT_RETRIES;
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;

    this.rateLimiter = new RateLimiter({
      requestsPerMinute: config.rateLimit ?? DEFAULT_RATE_LIMIT,
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Search the web via the You.com Search API (`/v1/search`).
   *
   * Returns news results first, then web results, matching the endpoint's
   * `{ results: { news, web } }` envelope. The legacy `hits` envelope is
   * still parsed for older deployments reached via a custom `baseUrl`.
   *
   * @param query  The search query string.
   * @param options  Optional search parameters.
   * @returns An array of search results.
   */
  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({ query });
    if (options?.numResults !== undefined) {
      params.set("count", String(options.numResults));
    }
    if (options?.country) {
      params.set("country", options.country);
    }
    if (options?.safesearch) {
      params.set("safesearch", options.safesearch);
    }

    const data = await this.request<SearchApiResponse>(
      `/v1/search?${params.toString()}`,
    );

    if (data.results) {
      const hits = [
        ...(data.results.news ?? []),
        ...(data.results.web ?? []),
      ];
      return hits
        .filter((hit) => hit.url && hit.title)
        .map((hit: RawSearchHit) => ({
          title: hit.title ?? "",
          url: hit.url ?? "",
          snippet: hit.snippets?.[0] ?? hit.description ?? "",
          description: hit.description ?? "",
          thumbnails: hit.thumbnails ?? [],
        }));
    }

    return (data.hits ?? []).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippets?.[0] ?? "",
      description: hit.description ?? "",
      thumbnails: hit.thumbnails ?? [],
    }));
  }

  /**
   * Perform deep research via the You.com Research API.
   *
   * @param query  The research query string.
   * @param options  Optional research parameters.
   * @returns A research result with an answer and source citations.
   */
  async research(
    query: string,
    options?: ResearchOptions,
  ): Promise<ResearchResult> {
    const params = new URLSearchParams({ query });
    if (options?.country) {
      params.set("country", options.country);
    }

    const data = await this.request<ResearchApiResponse>(
      `/research?${params.toString()}`,
    );

    return {
      answer: data.answer ?? "",
      sources: data.sources ?? [],
    };
  }

  /**
   * Get an AI-powered answer via the You.com RAG (Answer) API.
   *
   * @param query  The question to answer.
   * @param options  Optional answer parameters.
   * @returns An answer result with sources.
   */
  async answer(
    query: string,
    options?: AnswerOptions,
  ): Promise<AnswerResult> {
    const params = new URLSearchParams({ query });
    if (options?.country) {
      params.set("country", options.country);
    }
    if (options?.safesearch) {
      params.set("safesearch", options.safesearch);
    }

    const data = await this.request<AnswerApiResponse>(
      `/rag?${params.toString()}`,
    );

    const sources = (data.hits ?? []).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippets?.[0] ?? hit.description ?? "",
    }));

    return {
      answer: data.answer ?? "",
      sources,
    };
  }

  /**
   * Extract content from one or more URLs via the You.com Contents API.
   *
   * The API accepts a single `url` query parameter per request, so this
   * method issues one request per URL (respecting rate limits) and collects
   * the results.
   *
   * @param urls  The URLs to extract content from.
   * @param options  Optional extraction parameters.
   * @returns An array of extracted content results.
   */
  async contents(
    urls: string[],
    options?: ContentsOptions,
  ): Promise<ContentsResult[]> {
    const results: ContentsResult[] = [];

    for (const url of urls) {
      const params = new URLSearchParams({ url });
      if (options?.maxCharacters !== undefined) {
        params.set("max_characters", String(options.maxCharacters));
      }

      const data = await this.request<ContentsApiResponse>(
        `/contents?${params.toString()}`,
      );

      for (const item of data.contents ?? []) {
        results.push({
          url: item.url,
          title: item.title ?? "",
          content: item.content ?? "",
        });
      }
    }

    return results;
  }

  /**
   * Dispose the underlying rate limiter.  Call when the client is no longer
   * needed to allow the Node process to exit cleanly.
   */
  dispose(): void {
    this.rateLimiter.dispose();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Execute an authenticated GET request with rate limiting, retries, and
   * timeout.
   */
  private async request<T>(path: string): Promise<T> {
    let lastError: ApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Wait for a rate-limit token before sending the request.
      await this.rateLimiter.acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "X-API-Key": this.apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        // Log rate-limit headers when present.
        this.logRateLimitHeaders(response);

        if (response.ok) {
          this.rateLimiter.resetBackoff();
          return (await response.json()) as T;
        }

        // ---- Handle errors --------------------------------------------------

        const body = await response.text().catch(() => "");
        const retryable = response.status === 429 || response.status >= 500;

        lastError = new ApiError(
          `You.com API error ${response.status}: ${body || response.statusText}`,
          response.status,
          retryable,
        );

        if (response.status === 429) {
          this.rateLimiter.backoff();
        }

        if (!retryable || attempt === this.maxRetries) {
          throw lastError;
        }

        // Wait before retrying.
        await this.sleep(retryDelay(attempt));
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }

        // Network / timeout errors are retryable.
        const message =
          error instanceof Error ? error.message : String(error);
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";

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

        await this.sleep(retryDelay(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    // Should be unreachable, but satisfies the compiler.
    throw lastError ?? new ApiError("Unknown error", 0, false);
  }

  /** Log rate-limit response headers for observability. */
  private logRateLimitHeaders(response: Response): void {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const limit = response.headers.get("x-ratelimit-limit");
    const reset = response.headers.get("x-ratelimit-reset");

    if (remaining !== null || limit !== null || reset !== null) {
      console.debug(
        `[YouSearchClient] rate-limit headers — limit: ${limit}, remaining: ${remaining}, reset: ${reset}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
