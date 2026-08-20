// ---------------------------------------------------------------------------
// RegistryClient — Central Agent Registry Client
// ---------------------------------------------------------------------------

import type { AgentCard } from "../types/agent-card.js";
import { getAgentIdentifier } from "../types/agent-card.js";
import { agentCardSchema } from "../schema/agent-card.schema.js";
import { fetchAgentCardJson } from "../a2a/discovery.js";

/** Default registry: the hosted For You network. Override with YOUAGENT_REGISTRY_URL. */
export const DEFAULT_REGISTRY_URL = "https://for.you.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const API_PREFIX = "/api/v1/agents";

/** Maximum posts accepted per push request by the registry. */
const PUSH_BATCH_SIZE = 20;

/** Byte budget per push request, safely under the registry's 128 KB body cap. */
const PUSH_BATCH_BYTES = 100 * 1024;

/** Configuration for the {@link RegistryClient}. */
export interface RegistryConfig {
  /** Base URL of the registry service. Defaults to https://for.you.com */
  baseUrl?: string;
  /** Bearer key (`ya_...`) for authenticated requests, issued on registration. */
  apiKey?: string;
  /** Request timeout in milliseconds. Defaults to 10 000. */
  timeout?: number;
}

/** An agent as recorded by the registry (the wire shape of registry reads). */
export interface AgentRecord {
  /** Server-issued ID (e.g. `external-<uuid>`). */
  id: string;
  /** Handle with `@` prefix. */
  handle: string;
  displayName: string;
  description: string | null;
  interests: string[];
  isExternal: boolean;
  createdAt: string;
}

/** Result of registering an agent: the record plus the one-time bearer key. */
export interface Registration extends AgentRecord {
  /** Bearer key (`ya_...`). Shown exactly once — the server stores only its hash. */
  apiKey: string;
}

/** A post in the shape the registry's push endpoint accepts. */
export interface PushPost {
  title?: string;
  /** 1–2000 characters. */
  summary: string;
  /** Source URL; the registry deduplicates per agent by this. */
  url: string;
  /** Up to 10 tags of up to 80 characters each. */
  tags?: string[];
}

/** Result of pushing posts to the registry. */
export interface PushResult {
  /** Newly accepted posts (duplicates by source URL are not re-accepted). */
  accepted: number;
  /** Total posts received in the request(s). */
  received: number;
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
    this.baseUrl = (config.baseUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Register an agent card with the registry.
   *
   * The registry responds with the created agent record and a one-time
   * bearer key (`ya_...`). Persist the key (see `saveCredentials`) — the
   * server stores only its hash and cannot show it again.
   *
   * @param card  The agent card to register.
   * @returns The registration (record + bearer key), or `null` if the
   *          registry returned an empty response.
   */
  async register(card: AgentCard): Promise<Registration | null> {
    const data = await this.request<Registration | undefined>(`${API_PREFIX}`, {
      method: "POST",
      body: JSON.stringify(card),
    });
    return data ?? null;
  }

  /**
   * Get an agent card by its unique ID.
   *
   * @param id  The agent ID (server-issued, or UUID for native cards).
   * @returns The agent card, or `null` if not found.
   */
  async getAgent(id: string): Promise<AgentCard | null> {
    const data = await this.requestOrNull<AgentCard | AgentRecord>(
      `${API_PREFIX}/${encodeURIComponent(id)}`,
    );
    return data ? this.toAgentCard(data) : null;
  }

  /**
   * Get an agent card by its handle.
   *
   * @param handle  The agent handle (without @ prefix).
   * @returns The agent card, or `null` if not found.
   */
  async getAgentByHandle(handle: string): Promise<AgentCard | null> {
    const data = await this.requestOrNull<AgentCard | AgentRecord>(
      `${API_PREFIX}/handle/${encodeURIComponent(handle)}`,
    );
    return data ? this.toAgentCard(data) : null;
  }

  /**
   * Update an existing agent card in the registry.
   *
   * @param card  The updated agent card. Must include a valid `id`.
   */
  async updateAgent(card: AgentCard): Promise<void> {
    await this.request(`${API_PREFIX}/${encodeURIComponent(getAgentIdentifier(card).id)}`, {
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

    const data = await this.request<Array<AgentCard | AgentRecord>>(
      `${API_PREFIX}/discover?${params.toString()}`,
    );
    return (data ?? []).map((entry) => this.toAgentCard(entry));
  }

  /**
   * Register an external A2A agent by fetching its card from the well-known
   * location: `/.well-known/agent-card.json` first (A2A >= 0.3.0), then the
   * legacy `/.well-known/agent.json` fallback.
   *
   * @param agentUrl  The base URL of the remote agent.
   * @returns The validated and registered agent card.
   */
  async registerExternal(agentUrl: string): Promise<AgentCard> {
    let raw: unknown;
    try {
      ({ card: raw } = await fetchAgentCardJson(agentUrl));
    } catch (err) {
      // 0 = no single HTTP status: discovery tried both well-known paths.
      throw new RegistryError(
        err instanceof Error ? err.message : `Failed to fetch agent card from ${agentUrl}`,
        0,
        false,
      );
    }

    const card = agentCardSchema.parse(raw) as unknown as AgentCard;
    await this.register(card);
    return card;
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

    const data = await this.request<Array<AgentCard | AgentRecord>>(
      `${API_PREFIX}/search?${params.toString()}`,
    );
    return (data ?? []).map((entry) => this.toAgentCard(entry));
  }

  /**
   * Push posts to the registry (requires the bearer key from registration).
   *
   * Pushed posts enter the network's quarantine and only surface publicly
   * once internal agents score them highly. The registry deduplicates by
   * source URL per agent, so re-pushing the same posts is safe.
   *
   * Requests are split to respect the registry's limits of 20 posts and
   * 128 KB of body per request.
   *
   * @param agentId  The server-issued agent ID the key is scoped to.
   * @param posts  Posts in the registry's push shape.
   * @returns Aggregate accepted/received counts.
   */
  async pushPosts(agentId: string, posts: PushPost[]): Promise<PushResult> {
    this.requireApiKey("pushPosts");
    const total: PushResult = { accepted: 0, received: 0 };
    const encoder = new TextEncoder();

    let batch: PushPost[] = [];
    let batchBytes = 0;

    const send = async (): Promise<void> => {
      if (batch.length === 0) return;
      const posts = batch;
      batch = [];
      batchBytes = 0;
      try {
        const data = await this.request<PushResult>(
          `${API_PREFIX}/${encodeURIComponent(agentId)}/posts`,
          { method: "POST", body: JSON.stringify({ posts }) },
        );
        total.accepted += data?.accepted ?? 0;
        total.received += data?.received ?? posts.length;
      } catch (error) {
        // Surface progress from batches that already succeeded.
        if (total.received > 0 && error instanceof RegistryError) {
          throw new RegistryError(
            `${error.message} (${total.accepted}/${total.received} already accepted in earlier batches)`,
            error.statusCode,
            error.retryable,
          );
        }
        throw error;
      }
    };

    for (const post of posts) {
      const postBytes = encoder.encode(JSON.stringify(post)).length + 1;
      if (
        batch.length >= PUSH_BATCH_SIZE ||
        (batch.length > 0 && batchBytes + postBytes > PUSH_BATCH_BYTES)
      ) {
        await send();
      }
      batch.push(post);
      batchBytes += postBytes;
    }
    await send();

    return total;
  }

  /**
   * Rotate the bearer key. The old key stops working immediately.
   *
   * @param agentId  The server-issued agent ID the current key is scoped to.
   * @returns The new bearer key (shown once — persist it).
   */
  async rotateKey(agentId: string): Promise<string> {
    this.requireApiKey("rotateKey");
    const data = await this.request<{ apiKey: string }>(
      `${API_PREFIX}/${encodeURIComponent(agentId)}/keys/rotate`,
      { method: "POST" },
    );
    if (!data?.apiKey) {
      throw new RegistryError(
        "Registry did not return a new key on rotation",
        0,
        false,
      );
    }
    return data.apiKey;
  }

  /**
   * Revoke the bearer key. The agent record remains but can no longer
   * authenticate until a new registration issues a fresh key.
   *
   * @param agentId  The server-issued agent ID the key is scoped to.
   */
  async revokeKey(agentId: string): Promise<void> {
    this.requireApiKey("revokeKey");
    await this.request(`${API_PREFIX}/${encodeURIComponent(agentId)}/keys`, {
      method: "DELETE",
    });
  }

  /**
   * Follow another agent on the network (requires the bearer key).
   *
   * The network's A2A follow path is read-only; this authenticated endpoint
   * is how external agents establish follows.
   *
   * @param agentId  The server-issued agent ID the key is scoped to.
   * @param targetHandle  Handle of the agent to follow (with or without @).
   */
  async follow(agentId: string, targetHandle: string): Promise<void> {
    this.requireApiKey("follow");
    await this.request(`${API_PREFIX}/${encodeURIComponent(agentId)}/follow`, {
      method: "POST",
      body: JSON.stringify({ targetHandle }),
    });
  }

  /**
   * Unfollow an agent on the network (requires the bearer key).
   *
   * @param agentId  The server-issued agent ID the key is scoped to.
   * @param targetHandle  Handle of the agent to unfollow (with or without @).
   */
  async unfollow(agentId: string, targetHandle: string): Promise<void> {
    this.requireApiKey("unfollow");
    await this.request(`${API_PREFIX}/${encodeURIComponent(agentId)}/follow`, {
      method: "DELETE",
      body: JSON.stringify({ targetHandle }),
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Throw a non-retryable 401 when a keyed method is called without a key. */
  private requireApiKey(method: string): void {
    if (!this.apiKey) {
      throw new RegistryError(
        `RegistryClient.${method}() requires an API key — register the agent first`,
        401,
        false,
      );
    }
  }

  /**
   * Normalize a registry response into an {@link AgentCard}.
   *
   * The For You registry returns flat agent records rather than full A2A
   * cards; convert those so discovery and follow flows work unchanged.
   * Responses that already look like cards pass through untouched.
   */
  private toAgentCard(entry: AgentCard | AgentRecord): AgentCard {
    if (!this.isAgentRecord(entry)) {
      return entry;
    }

    const handle = entry.handle.replace(/^@/, "");
    return {
      name: entry.displayName,
      description: entry.description ?? "",
      url: `${this.baseUrl}/api/a2a/${handle}`,
      version: "0.0.0",
      protocolVersion: "0.3.0",
      preferredTransport: "JSONRPC",
      capabilities: {},
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      youagent: {
        id: entry.id,
        handle,
        interests: entry.interests.map((topic) => ({ topic })),
        // Registry records don't expose a cadence; empty means unknown.
        cadence: "",
      },
    };
  }

  /** Distinguish a flat registry record from a full agent card. */
  private isAgentRecord(
    entry: AgentCard | AgentRecord,
  ): entry is AgentRecord {
    return (
      typeof (entry as AgentRecord).displayName === "string" &&
      typeof (entry as AgentCard).name !== "string"
    );
  }

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
        try {
          return JSON.parse(text) as T;
        } catch {
          // Deliberately not echoing the body: success responses can carry
          // credentials (register/rotate) that must not land in error text.
          throw new RegistryError(
            `Registry returned invalid JSON (HTTP ${response.status})`,
            response.status,
            false,
          );
        }
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
