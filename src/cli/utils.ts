import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCard } from '../types/agent-card.js';
import { getAgentIdentifier } from '../types/agent-card.js';
import type { SearchProvider } from '../client/types.js';
import { YouSearchClient } from '../client/you-client.js';
import { NetworkSearchClient } from '../client/network-search-client.js';
import { DEFAULT_REGISTRY_URL } from '../registry/registry-client.js';
import type { RegistryClient } from '../registry/registry-client.js';
import { loadCredentials } from '../registry/credentials.js';

/**
 * Returns the path to the ~/.youagent directory.
 */
export function getAgentDir(): string {
  return join(homedir(), '.youagent');
}

/**
 * Returns the path to ~/.youagent/agent-card.json.
 */
export function getAgentCardPath(): string {
  return join(getAgentDir(), 'agent-card.json');
}

/**
 * Reads and parses the agent card from disk.
 * Returns null if the file does not exist.
 */
export async function loadAgentCard(): Promise<AgentCard | null> {
  try {
    const raw = await readFile(getAgentCardPath(), 'utf-8');
    return JSON.parse(raw) as AgentCard;
  } catch {
    return null;
  }
}

/**
 * Writes an agent card to ~/.youagent/agent-card.json.
 * Creates the directory if it does not exist.
 */
export async function saveAgentCard(card: AgentCard): Promise<void> {
  const dir = getAgentDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getAgentCardPath(), JSON.stringify(card, null, 2) + '\n', 'utf-8');
}

/**
 * Returns the registry base URL to browse: `YOUAGENT_REGISTRY_URL` when set,
 * else the network this agent is registered with, else the default network.
 */
export async function getRegistryUrl(): Promise<string> {
  const envUrl = process.env['YOUAGENT_REGISTRY_URL'];
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }
  const creds = await loadCredentials();
  return creds?.baseUrl ?? DEFAULT_REGISTRY_URL;
}

/**
 * Resolve a search provider for CLI commands.
 *
 * Preference order: an explicit `--api-key` flag, then the `YDC_API_KEY`
 * env var (both → direct You.com client), then stored registration
 * credentials (→ the network's metered search proxy). Returns null when
 * none are available.
 */
export async function resolveSearchProvider(
  explicitKey?: string,
): Promise<{ client: SearchProvider; viaNetwork: boolean } | null> {
  const apiKey = explicitKey ?? process.env['YDC_API_KEY'];
  if (apiKey) {
    return { client: new YouSearchClient({ apiKey }), viaNetwork: false };
  }

  const creds = await loadCredentials();
  if (creds) {
    return {
      client: new NetworkSearchClient({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
      }),
      viaNetwork: true,
    };
  }

  return null;
}

/** A follow/unfollow target resolved against the registry. */
export interface ResolvedAgent {
  /** Canonical agent ID (server-issued for registry records). */
  id: string;
  /** Handle without the @ prefix, when known. */
  handle?: string;
  /** Display name, when known. */
  name?: string;
}

/**
 * Resolve a CLI agent target — `@handle`, bare handle, or agent ID — to a
 * registry record. `@`-prefixed targets are looked up by handle only;
 * other targets are tried as an ID first, then as a handle.
 *
 * Returns null when the registry has no matching agent. Network errors
 * propagate as RegistryError.
 */
export async function resolveAgentTarget(
  registry: RegistryClient,
  target: string,
): Promise<ResolvedAgent | null> {
  const bare = target.replace(/^@/, '');

  const toResolved = (card: AgentCard): ResolvedAgent => {
    const ident = getAgentIdentifier(card);
    return { id: ident.id, handle: ident.handle, name: card.name };
  };

  if (target.startsWith('@')) {
    const card = await registry.getAgentByHandle(bare);
    return card ? toResolved(card) : null;
  }

  const byId = await registry.getAgent(target);
  if (byId) {
    return toResolved(byId);
  }
  const byHandle = await registry.getAgentByHandle(bare);
  return byHandle ? toResolved(byHandle) : null;
}

/**
 * Converts text to a URL-safe handle (lowercase, alphanumeric + hyphens).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
