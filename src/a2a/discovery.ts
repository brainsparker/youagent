/**
 * A2A agent card discovery.
 *
 * A2A spec v0.3.0 (July 2025) renamed the well-known agent card path from
 * `/.well-known/agent.json` to `/.well-known/agent-card.json`. Current
 * clients and tooling (a2a-js, a2a-python, a2a-inspector) resolve the new
 * path first; many servers in the wild still serve only the legacy one.
 *
 * `fetchAgentCardJson` implements the ecosystem convention: try the
 * canonical path first, then fall back to the legacy path.
 */

/** Canonical well-known agent card path (A2A >= 0.3.0). */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Legacy well-known agent card path (A2A <= 0.2.x). Deprecated. */
export const LEGACY_AGENT_CARD_PATH = '/.well-known/agent.json';

/** Result of a successful discovery fetch. */
export interface AgentCardFetchResult {
  /** The raw parsed JSON agent card (unvalidated). */
  card: unknown;
  /** The well-known path that answered. */
  path: string;
}

/**
 * Fetch an agent card from a remote agent's base URL.
 *
 * Tries the canonical `/.well-known/agent-card.json` first and falls back to
 * the legacy `/.well-known/agent.json`. Throws when neither path yields a
 * parseable card, reporting the first failure encountered.
 */
export async function fetchAgentCardJson(agentUrl: string): Promise<AgentCardFetchResult> {
  const base = agentUrl.replace(/\/+$/, '');
  let firstFailure: string | undefined;

  for (const path of [AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH]) {
    try {
      const res = await fetch(`${base}${path}`);
      if (res.ok) {
        return { card: await res.json(), path };
      }
      if (!firstFailure) {
        const text = await res.text().catch(() => '');
        firstFailure = `HTTP ${res.status}${text ? ` ${text}` : ''} at ${path}`;
      }
    } catch (err) {
      if (!firstFailure) {
        firstFailure = `${err instanceof Error ? err.message : String(err)} at ${path}`;
      }
    }
  }

  throw new Error(
    `Agent card discovery failed for ${base} ` +
      `(tried ${AGENT_CARD_PATH}, then legacy ${LEGACY_AGENT_CARD_PATH}): ${firstFailure}`,
  );
}
