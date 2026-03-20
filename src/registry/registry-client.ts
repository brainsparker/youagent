// ---------------------------------------------------------------------------
// RegistryClient — Central Agent Registry Client
// ---------------------------------------------------------------------------

import type { AgentCard } from "../types/agent-card.js";

const DEFAULT_BASE_URL = "https://registry.youagent.dev";
const DEFAULT_TIMEOUT_MS = 10_000;
const API_PREFIX = "/api/v1/agents";

/** Configuration for the {@link RegistryClient}. */
export interface RegistryConfig {
  /** Base URL of the registry service. Defaults to https://registry.youagent.dev */
  baseUrl?: string;
  /** Optional API key for authenticated requests. */
  apiKey?: string;
  /** Request timeout in milliseconds. Defaults to 10 000. */
  timeout?: number;
}

/** Error thrown when a registry API call fails. */
export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * A typed client for the YouAgent central agent registry.
 *
 * Supports registering, discovering, and searching for agent cards with
 * request timeouts via AbortController.
 */
export class RegistryClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: RegistryConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Register an agent card with the registry.
   *
   * @param card  The agent card to register.
   */
  async register(card: AgentCard): Promise<void> {
    await this.request(`${API_PREFIX}`, {
      method: "POST",
      body: JSON.stringify(card),
    });
  }

  /**
   * Get an agent card by its unique ID.
   *
   * @param id  The agent UUID.
   * @returns The agent card, or `null` if not found.
   */
  async getAgent(id: string): Promise<AgentCard | null> {
    return this.requestOrNull<AgentCard>(
      `${API_PREFIX}/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Get an agent card by its handle.
   *
   * @param handle  The agent handle (without @ prefix).
   * @returns The agent card, or `null` if not found.
   */
  async getAgentByHandle(handle: string): Promise<AgentCard | null> {
    return this.requestOrNull<AgentCard>(
      `${API_PREFIX}/handle/${encodeURIComponent(handle)}`,
    );
  }

  /**
   * Update an existing agent card in the registry.
   *
   * @param card  The updated agent card. Must include a valid `id`.
   */
  async updateAgent(card: AgentCard): Promise<void> {
    await this.request(`${API_PREFIX}/${encodeURIComponent(card.youagent.id)}`, {
      method: "PUT",
      body: JSON.stringify(card),
    });
  }

  /**
   * Remove an agent from the registry.
   *
   * @param id  The agent UUID to remove.
   */
  async removeAgent(id: string): Promise<void> {
    await this.request(`${API_PREFIX}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /**
   * Discover agents with overlapping interests.
   *
   * @param interests  A list of topic strings to match against.
   * @param limit  Maximum number of results (default decided by server).
   * @returns An array of matching agent cards.
   */
  async discover(interests: string[], limit?: number): Promise<AgentCard[]> {
    const params = new URLSearchParams({
      interests: interests.join(","),
    });
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }

    const data = await this.request<AgentCard[]>(
      `${API_PREFIX}/discover?${params.toString()}`,
    );
    return data ?? [];
  }

  /**
   * Search agents by query string (topic, handle, or domain).
   *
   * @param query  Free-text search query.
   * @param limit  Maximum number of results (default decided by server).
   * @returns An array of matching agent cards.
   */
  async search(query: string, limit?: number): Promise<AgentCard[]> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }

    const data = await this.request<AgentCard[]>(
      `${API_PREFIX}/search?${params.toString()}`,
    );
    return data ?? [];
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Execute an HTTP request with timeout and error handling.
   */
  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      if (init?.body) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body,
        signal: controller.signal,
      });

      if (response.ok) {
        // Some endpoints (DELETE, POST) may return 204 No Content.
        const text = await response.text();
        if (!text) {
          return undefined as unknown as T;
        }
        return JSON.parse(text) as T;
      }

      const body = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;

      throw new RegistryError(
        `Registry API error ${response.status}: ${body || response.statusText}`,
        response.status,
        retryable,
      );
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }

      const message =
        error instanceof Error ? error.message : String(error);
      const isAbort =
        error instanceof DOMException && error.name === "AbortError";

      throw new RegistryError(
        isAbort
          ? `Request timed out after ${this.timeoutMs}ms`
          : `Network error: ${message}`,
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Convenience wrapper that returns `null` on 404 instead of throwing.
   */
  private async requestOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>(path);
    } catch (error) {
      if (error instanceof RegistryError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }
}
