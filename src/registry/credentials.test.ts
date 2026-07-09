import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  deleteCredentials,
} from './credentials.js';
import type { RegistryCredentials } from './credentials.js';

const CREDS: RegistryCredentials = {
  baseUrl: 'https://network.test',
  agentId: 'external-abc',
  handle: 'climate-watch',
  apiKey: 'ya_secret',
  createdAt: '2026-07-09T00:00:00.000Z',
};

let dir: string | undefined;

async function tempPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'youagent-creds-'));
  return join(dir, 'nested', 'credentials.json');
}

afterEach(async () => {
  delete process.env['YOUAGENT_REGISTRY_KEY'];
  delete process.env['YOUAGENT_AGENT_ID'];
  delete process.env['YOUAGENT_REGISTRY_URL'];
  delete process.env['YOUAGENT_HANDLE'];
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('credentials', () => {
  it('round-trips credentials through save and load', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path);
    await expect(loadCredentials(path)).resolves.toEqual(CREDS);
  });

  it('writes the file with owner-only permissions', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path);

    if (process.platform !== 'win32') {
      const { mode } = await stat(path);
      expect(mode & 0o777).toBe(0o600);
    }
  });

  it('keeps owner-only permissions when overwriting', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path);
    await saveCredentials({ ...CREDS, apiKey: 'ya_rotated' }, path);

    if (process.platform !== 'win32') {
      const { mode } = await stat(path);
      expect(mode & 0o777).toBe(0o600);
    }
    await expect(loadCredentials(path)).resolves.toMatchObject({
      apiKey: 'ya_rotated',
    });
  });

  it('returns null when the file is missing', async () => {
    const path = await tempPath();
    await expect(loadCredentials(path)).resolves.toBeNull();
  });

  it('returns null for malformed contents', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not json', 'utf-8');
    await expect(loadCredentials(path)).resolves.toBeNull();
  });

  it('lets YOUAGENT_REGISTRY_KEY override the stored key', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path);
    process.env['YOUAGENT_REGISTRY_KEY'] = 'ya_from_env';

    await expect(loadCredentials(path)).resolves.toMatchObject({
      apiKey: 'ya_from_env',
      agentId: 'external-abc',
    });
  });

  it('builds env-only credentials from KEY + AGENT_ID without a file', async () => {
    const path = await tempPath();
    process.env['YOUAGENT_REGISTRY_KEY'] = 'ya_ci_key';
    process.env['YOUAGENT_AGENT_ID'] = 'external-ci';
    process.env['YOUAGENT_REGISTRY_URL'] = 'https://ci.network.test/';

    await expect(loadCredentials(path)).resolves.toMatchObject({
      apiKey: 'ya_ci_key',
      agentId: 'external-ci',
      baseUrl: 'https://ci.network.test',
    });
  });

  it('never attaches the env key to a different registry than YOUAGENT_REGISTRY_URL', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path); // file is for https://network.test
    process.env['YOUAGENT_REGISTRY_KEY'] = 'ya_for_other_host';
    process.env['YOUAGENT_REGISTRY_URL'] = 'https://other.network.test';

    await expect(loadCredentials(path)).resolves.toBeNull();
  });

  it('deletes credentials idempotently', async () => {
    const path = await tempPath();
    await saveCredentials(CREDS, path);
    await deleteCredentials(path);
    await expect(loadCredentials(path)).resolves.toBeNull();
    // Deleting again is not an error.
    await deleteCredentials(path);
  });
});
