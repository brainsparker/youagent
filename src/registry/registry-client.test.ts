import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistryClient, RegistryError } from './registry-client.js';
import type { AgentCard } from '../types/agent-card.js';

const BASE_URL = 'https://network.test';

const CARD: AgentCard = {
  name: 'Climate Watch',
  description: 'Tracks carbon capture',
  url: 'http://localhost:3141',
  version: '0.1.0',
  protocolVersion: '0.2.1',
  capabilities: {},
  skills: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  youagent: {
    id: '8a9c1f2e-0000-4000-8000-000000000000',
    handle: 'climate-watch',
    interests: [{ topic: 'carbon capture' }],
    cadence: '6h',
  },
};

const RECORD = {
  id: 'external-abc',
  handle: '@climate-watch',
  displayName: 'Climate Watch',
  description: 'Tracks carbon capture',
  interests: ['carbon capture', 'grid-scale batteries'],
  isExternal: true,
  createdAt: '2026-07-09T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RegistryClient.register', () => {
  it('returns the registration including the one-time bearer key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ...RECORD, apiKey: 'ya_secret' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL });
    const registration = await client.register(CARD);

    expect(registration?.apiKey).toBe('ya_secret');
    expect(registration?.id).toBe('external-abc');
    expect(registration?.handle).toBe('@climate-watch');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/agents`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).name).toBe('Climate Watch');
  });

  it('returns null when the registry responds with an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const client = new RegistryClient({ baseUrl: BASE_URL });
    await expect(client.register(CARD)).resolves.toBeNull();
  });
});

describe('RegistryClient.pushPosts', () => {
  it('sends the bearer key and returns accepted/received counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: 2, received: 3 }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_secret' });
    const posts = [
      { summary: 'a', url: 'https://a.test' },
      { summary: 'b', url: 'https://b.test' },
      { summary: 'c', url: 'https://c.test' },
    ];
    const result = await client.pushPosts('external-abc', posts);

    expect(result).toEqual({ accepted: 2, received: 3 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/agents/external-abc/posts`);
    expect(init.headers['Authorization']).toBe('Bearer ya_secret');
    expect(JSON.parse(init.body).posts).toHaveLength(3);
  });

  it('splits batches by byte size to stay under the server body cap', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      () => Promise.resolve(jsonResponse({ accepted: 1, received: 1 }, 202)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_secret' });
    // 20 posts ≈ 8 KB each (multi-byte summary + long URL) ≈ 160 KB total —
    // must split despite count ≤ 20.
    const posts = Array.from({ length: 20 }, (_, i) => ({
      summary: '€'.repeat(2000),
      url: `https://example.test/${'a'.repeat(1900)}/${i}`,
    }));
    await client.pushPosts('external-abc', posts);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new TextEncoder().encode(init.body as string).length).toBeLessThan(
        128 * 1024,
      );
    }
  });

  it('splits more than 20 posts into batches and aggregates the counts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accepted: 20, received: 20 }, 202))
      .mockResolvedValueOnce(jsonResponse({ accepted: 3, received: 5 }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_secret' });
    const posts = Array.from({ length: 25 }, (_, i) => ({
      summary: `post ${i}`,
      url: `https://example.test/${i}`,
    }));
    const result = await client.pushPosts('external-abc', posts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).posts).toHaveLength(20);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).posts).toHaveLength(5);
    expect(result).toEqual({ accepted: 23, received: 25 });
  });

  it('throws a non-retryable 401 RegistryError without an API key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL });
    const err = await client
      .pushPosts('external-abc', [{ summary: 'a', url: 'https://a.test' }])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).statusCode).toBe(401);
    expect((err as RegistryError).retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a key-scope 403 as a non-retryable RegistryError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: 'Key is not scoped to this agent' }, 403),
      ),
    );

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_other' });
    const err = await client
      .pushPosts('external-abc', [{ summary: 'a', url: 'https://a.test' }])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).statusCode).toBe(403);
    expect((err as RegistryError).retryable).toBe(false);
  });
});

describe('RegistryClient key management', () => {
  it('rotateKey posts to the rotate endpoint and returns the new key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ apiKey: 'ya_new' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_old' });
    await expect(client.rotateKey('external-abc')).resolves.toBe('ya_new');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/agents/external-abc/keys/rotate`);
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer ya_old');
  });

  it('revokeKey deletes the key endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_old' });
    await client.revokeKey('external-abc');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/agents/external-abc/keys`);
    expect(init.method).toBe('DELETE');
  });
});

describe('RegistryClient.follow', () => {
  it('posts the target handle to the keyed follow endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: 'ya_secret' });
    await client.follow('external-abc', 'grid-watch');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/agents/external-abc/follow`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ targetHandle: 'grid-watch' });
  });
});

describe('RegistryClient record normalization', () => {
  it('converts flat agent records from discover into agent cards', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([RECORD])));

    const client = new RegistryClient({ baseUrl: BASE_URL });
    const [card] = await client.discover(['carbon capture']);

    expect(card.name).toBe('Climate Watch');
    expect(card.youagent?.id).toBe('external-abc');
    expect(card.youagent?.handle).toBe('climate-watch');
    expect(card.youagent?.interests).toEqual([
      { topic: 'carbon capture' },
      { topic: 'grid-scale batteries' },
    ]);
    expect(card.url).toBe(`${BASE_URL}/api/a2a/climate-watch`);
  });

  it('passes through responses that are already agent cards', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(CARD)));

    const client = new RegistryClient({ baseUrl: BASE_URL });
    const card = await client.getAgent('8a9c1f2e-0000-4000-8000-000000000000');

    expect(card).toEqual(CARD);
  });

  it('normalizes a single record from getAgentByHandle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(RECORD)));

    const client = new RegistryClient({ baseUrl: BASE_URL });
    const card = await client.getAgentByHandle('climate-watch');

    expect(card?.youagent?.handle).toBe('climate-watch');
    expect(card?.name).toBe('Climate Watch');
  });

  it('returns null on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Not found' }, 404)),
    );

    const client = new RegistryClient({ baseUrl: BASE_URL });
    await expect(client.getAgent('missing')).resolves.toBeNull();
  });
});
