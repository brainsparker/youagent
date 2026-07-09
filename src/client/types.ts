// ---------------------------------------------------------------------------
// You.com API Client – Type Definitions
// ---------------------------------------------------------------------------

/** Configuration for the YouSearchClient. */
export interface YouClientConfig {
  /** You.com API key (YDC API). */
  apiKey: string;
  /** Override the base URL (default: https://ydc-index.io). */
  baseUrl?: string;
  /** Maximum requests per minute (default: 60). */
  rateLimit?: number;
  /** Number of retry attempts on transient failures (default: 3). */
  retries?: number;
  /** Request timeout in milliseconds (default: 30 000). */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Maximum number of results to return. */
  numResults?: number;
  /** Two-letter country code (e.g. "US", "GB"). */
  country?: string;
  /** Safe-search level. */
  safesearch?: "off" | "moderate" | "strict";
}

export interface SearchResultThumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface SearchResultHit {
  title: string;
  url: string;
  description: string;
  snippets: string[];
  thumbnails?: SearchResultThumbnail[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  description: string;
  thumbnails: SearchResultThumbnail[];
}

/**
 * Anything that can run a web search and return {@link SearchResult}s.
 *
 * Satisfied by both `YouSearchClient` (direct You.com key) and
 * `NetworkSearchClient` (For You network's metered proxy), so consumers like
 * the daemon can accept either.
 */
export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  dispose(): void;
}

/** A raw hit as returned inside the /v1/search response arrays. */
export interface RawSearchHit {
  title?: string;
  url?: string;
  description?: string;
  snippets?: string[];
  thumbnails?: SearchResultThumbnail[];
}

/**
 * Raw envelope returned by the search endpoint.
 *
 * The live You.com endpoint (https://ydc-index.io/v1/search) returns
 * `{ results: { news, web } }`; the legacy `hits` shape is still parsed for
 * compatibility with older deployments.
 */
export interface SearchApiResponse {
  hits?: SearchResultHit[];
  results?: {
    news?: RawSearchHit[];
    web?: RawSearchHit[];
  };
  latency?: number;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export interface ResearchOptions {
  /** Two-letter country code. */
  country?: string;
}

export interface ResearchResult {
  answer: string;
  sources: ResearchSource[];
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
}

/** Raw envelope returned by the /research endpoint. */
export interface ResearchApiResponse {
  answer: string;
  sources?: ResearchSource[];
}

// ---------------------------------------------------------------------------
// Answer (RAG)
// ---------------------------------------------------------------------------

export interface AnswerOptions {
  /** Two-letter country code. */
  country?: string;
  /** Safe-search level. */
  safesearch?: "off" | "moderate" | "strict";
}

export interface AnswerResult {
  answer: string;
  sources: AnswerSource[];
}

export interface AnswerSource {
  title: string;
  url: string;
  snippet: string;
}

/** Raw envelope returned by the /rag endpoint. */
export interface AnswerApiResponse {
  answer: string;
  hits?: Array<{
    title: string;
    url: string;
    description: string;
    snippets: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

export interface ContentsOptions {
  /** Maximum number of characters to extract per page. */
  maxCharacters?: number;
}

export interface ContentsResult {
  url: string;
  title: string;
  content: string;
}

/** Raw envelope returned by the /contents endpoint. */
export interface ContentsApiResponse {
  contents: Array<{
    url: string;
    title: string;
    content: string;
  }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  /** HTTP status code (0 when the request never reached the server). */
  readonly statusCode: number;
  /** Whether the caller may retry the request. */
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

export interface RateLimiterConfig {
  /** Maximum tokens (requests) per minute (default: 60). */
  requestsPerMinute: number;
}
