/**
 * Agent Card discovery over HTTP (A2A well-known URI strategy).
 *
 * A2A v1.0 moved the well-known path from `/.well-known/agent.json` to
 * `/.well-known/agent-card.json` (RFC 8615) and registered the
 * `application/a2a+json` media type. Agents in the wild are split across
 * both, so discovery probes the v1.0 path first and falls back to the
 * legacy path. Whatever comes back is upgraded to the v1.0 card structure.
 */

import {
  A2A_CARD_MEDIA_TYPE,
  A2A_LEGACY_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
  normalizeAgentCard,
  type AgentCard,
} from '../types/agent-card.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** One probe of a candidate card URL. */
export interface DiscoveryAttempt {
  url: string;
  /** HTTP status, or 0 when the request itself failed (network, timeout). */
  status: number;
  error?: string;
}

/** Thrown when no probed path returned an agent card. */
export class AgentCardDiscoveryError extends Error {
  constructor(
    message: string,
    /** Status of the last attempt, or 0 for a network-level failure. */
    public readonly status: number,
    public readonly attempts: DiscoveryAttempt[],
  ) {
    super(message);
    this.name = 'AgentCardDiscoveryError';
  }
}

export interface FetchAgentCardOptions {
  /** Override the global fetch (tests, custom agents). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 10 000 ms. */
  timeoutMs?: number;
  /**
   * Paths to probe, in order. Defaults to the v1.0 well-known path followed
   * by the pre-1.0 path.
   */
  paths?: string[];
}

/** Well-known paths probed by default, most current first. */
export const DEFAULT_DISCOVERY_PATHS: readonly string[] = [
  A2A_WELL_KNOWN_PATH,
  A2A_LEGACY_WELL_KNOWN_PATH,
];

/**
 * Fetch a remote agent's card from its base URL.
 *
 * Probes `/.well-known/agent-card.json` and then `/.well-known/agent.json`,
 * sending an `Accept` header that prefers `application/a2a+json`. The first
 * 2xx JSON body wins and is normalized to the v1.0 structure (legacy
 * `url`/`protocolVersion` cards gain `supportedInterfaces`). The card is
 * not schema-validated here; run it through `agentCardSchema` when you
 * need strict validation.
 *
 * @throws AgentCardDiscoveryError when every probed path fails.
 */
export async function fetchAgentCard(
  agentUrl: string,
  options: FetchAgentCardOptions = {},
): Promise<AgentCard> {
  const base = agentUrl.replace(/\/+$/, '');
  const paths = options.paths ?? DEFAULT_DISCOVERY_PATHS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts: DiscoveryAttempt[] = [];

  for (const path of paths) {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: `${A2A_CARD_MEDIA_TYPE}, application/json;q=0.9` },
        signal: controller.signal,
      });

      if (res.ok) {
        const raw: unknown = await res.json();
        return normalizeAgentCard(raw) as AgentCard;
      }

      const text = await res.text().catch(() => '');
      attempts.push({ url, status: res.status, error: text || undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push({ url, status: 0, error: message });
    } finally {
      clearTimeout(timer);
    }
  }

  const last = attempts[attempts.length - 1];
  const summary = attempts
    .map((a) => `${a.url} -> ${a.status === 0 ? `error: ${a.error ?? 'unknown'}` : `HTTP ${a.status}`}`)
    .join('; ');
  throw new AgentCardDiscoveryError(
    `Discovery failed for ${base} (${summary})`,
    last?.status ?? 0,
    attempts,
  );
}
