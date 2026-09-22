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
import {
  AgentCardSignatureError,
  verifyAgentCardSignatures,
  type AgentCardVerification,
  type VerifyAgentCardOptions,
} from './card-signing.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Signature verification for a fetched card (A2A spec section 8.4.3).
 *
 * When `jwks` is omitted, JWKS URLs are followed only on the origin the card
 * was fetched from: the signature then proves the card was issued by whoever
 * controls that host, which is what a registry or cache cannot forge. Pass
 * `keys` for a pinned trust store, or `jwks: { origins: 'any' }` to trust
 * whatever `jku` the card names (not recommended).
 */
export interface DiscoverySignatureOptions extends VerifyAgentCardOptions {
  /**
   * Fail discovery when the card carries no signature at all. Defaults to
   * true; set false to verify signatures when present but accept unsigned
   * cards (the verification result is then `undefined`).
   */
  require?: boolean;
}

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
  /**
   * Verify the card's signatures after fetching. Off when omitted (the card
   * is returned as served). See `DiscoverySignatureOptions`.
   */
  signature?: DiscoverySignatureOptions;
}

/** A fetched card together with the outcome of signature verification. */
export interface VerifiedAgentCard {
  card: AgentCard;
  /** Which signature verified. `undefined` only when `require: false` and the card was unsigned. */
  verification: AgentCardVerification | undefined;
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
 * @throws AgentCardSignatureError when `options.signature` is set and the card fails verification.
 */
export async function fetchAgentCard(
  agentUrl: string,
  options: FetchAgentCardOptions = {},
): Promise<AgentCard> {
  return (await fetchVerifiedAgentCard(agentUrl, options)).card;
}

/**
 * Like `fetchAgentCard`, but also returns the signature verification result
 * so callers can record which key vouched for the card.
 */
export async function fetchVerifiedAgentCard(
  agentUrl: string,
  options: FetchAgentCardOptions = {},
): Promise<VerifiedAgentCard> {
  const card = await fetchRawAgentCard(agentUrl, options);
  if (!options.signature) return { card, verification: undefined };

  const { require = true, ...verifyOptions } = options.signature;
  if (!card.signatures?.length && !require) return { card, verification: undefined };

  // Default JWKS policy: same origin as the URL the card was fetched from.
  if (!verifyOptions.jwks) {
    let origin: string | undefined;
    try {
      origin = new URL(agentUrl).origin;
    } catch {
      origin = undefined;
    }
    if (origin) verifyOptions.jwks = { origins: [origin], fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };
  } else {
    verifyOptions.jwks = {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      ...verifyOptions.jwks,
    };
  }

  const verification = await verifyAgentCardSignatures(card, verifyOptions);
  return { card, verification };
}

async function fetchRawAgentCard(agentUrl: string, options: FetchAgentCardOptions): Promise<AgentCard> {
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
