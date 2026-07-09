// ---------------------------------------------------------------------------
// Registry credentials — persistence for the network-issued bearer key
// ---------------------------------------------------------------------------
//
// Registering with a For You network returns a one-time `ya_...` bearer key
// (the server stores only its hash). This module persists that key locally in
// ~/.youagent/credentials.json with owner-only permissions so later runs can
// push posts and use the network's metered search proxy.

import { readFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_REGISTRY_URL } from './registry-client.js';

/** Credentials issued by a registry on registration. */
export interface RegistryCredentials {
  /** Base URL of the registry that issued the key. */
  baseUrl: string;
  /** Server-issued agent ID (e.g. `external-<uuid>`), distinct from the local card UUID. */
  agentId: string;
  /** Handle as registered on the network, without the `@` prefix. */
  handle: string;
  /** Bearer key (`ya_...`). Shown once by the server; only stored here. */
  apiKey: string;
  /** ISO 8601 datetime the key was issued or last rotated. */
  createdAt: string;
}

/**
 * Returns the path to ~/.youagent/credentials.json.
 */
export function getCredentialsPath(): string {
  return join(homedir(), '.youagent', 'credentials.json');
}

/**
 * Reads registry credentials, from the environment or from disk.
 *
 * Resolution order:
 * 1. `YOUAGENT_REGISTRY_KEY` + `YOUAGENT_AGENT_ID` set — fully env-provided
 *    credentials (for CI; no file needed). The registry is
 *    `YOUAGENT_REGISTRY_URL` or the default network, and `YOUAGENT_HANDLE`
 *    supplies the handle when known.
 * 2. The credentials file. When `YOUAGENT_REGISTRY_KEY` alone is set it
 *    overrides the stored key — but only for the registry the file was
 *    written for; if `YOUAGENT_REGISTRY_URL` points at a different host,
 *    the env key is NOT attached to the file's registry and null is
 *    returned (a key must never be sent to a host it wasn't issued for).
 *
 * Returns null when nothing usable is found.
 *
 * @param path  Override the credentials file path (defaults to ~/.youagent/credentials.json).
 */
export async function loadCredentials(
  path: string = getCredentialsPath(),
): Promise<RegistryCredentials | null> {
  const envKey = process.env['YOUAGENT_REGISTRY_KEY'];
  const envAgentId = process.env['YOUAGENT_AGENT_ID'];
  const envUrl = process.env['YOUAGENT_REGISTRY_URL']?.replace(/\/+$/, '');

  if (envKey && envAgentId) {
    return {
      baseUrl: envUrl ?? DEFAULT_REGISTRY_URL,
      agentId: envAgentId,
      handle: process.env['YOUAGENT_HANDLE'] ?? '',
      apiKey: envKey,
      createdAt: '',
    };
  }

  let creds: RegistryCredentials | null = null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RegistryCredentials>;
    if (
      typeof parsed.baseUrl === 'string' &&
      typeof parsed.agentId === 'string' &&
      typeof parsed.handle === 'string' &&
      typeof parsed.apiKey === 'string'
    ) {
      creds = {
        baseUrl: parsed.baseUrl,
        agentId: parsed.agentId,
        handle: parsed.handle,
        apiKey: parsed.apiKey,
        createdAt: parsed.createdAt ?? '',
      };
    }
  } catch {
    // Missing or unreadable file.
  }

  if (envKey && creds) {
    if (envUrl && envUrl !== creds.baseUrl.replace(/\/+$/, '')) {
      // The env key was presumably issued by YOUAGENT_REGISTRY_URL's registry,
      // not the file's — set YOUAGENT_AGENT_ID to use it without a file.
      return null;
    }
    return { ...creds, apiKey: envKey };
  }
  return creds;
}

/**
 * Writes registry credentials to disk with owner-only permissions (0600).
 *
 * @param creds  The credentials to persist.
 * @param path  Override the credentials file path.
 */
export async function saveCredentials(
  creds: RegistryCredentials,
  path: string = getCredentialsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // writeFile's mode only applies on creation; enforce on overwrite too.
  await chmod(path, 0o600);
}

/**
 * Deletes the stored credentials, e.g. after revoking the key.
 * Missing file is not an error.
 */
export async function deleteCredentials(
  path: string = getCredentialsPath(),
): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}
