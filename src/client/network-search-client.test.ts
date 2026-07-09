import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkSearchClient } from './network-search-client.js';
import { ApiError } from './types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NetworkSearchClient', () => {
  it('requires a bearer key', () => {
    expect(() => new NetworkSearchClient({ apiKey: '' })).toThrow(/bearer key/);
  });

  it('queries the proxy with the bearer key and parses results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { title: 'Hit', url: 'https://a.test', description: 'desc' },
            { title: '', url: 'https://skipped.test', description: 'no title' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NetworkSearchClient({
      baseUrl: 'https://network.test',
      apiKey: 'ya_secret',
    });
    const results = await client.search('carbon capture', { numResults: 3 });

    expect(results).toEqual([
      {
        title: 'Hit',
        url: 'https://a.test',
        snippet: 'desc',
        description: 'desc',
        thumbnails: [],
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://network.test/api/v1/search?q=carbon+capture&count=3',
    );
    expect(init.headers['Authorization']).toBe('Bearer ya_secret');
  });

  it('treats a 429 (daily cap) as non-retryable with a clear message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NetworkSearchClient({
      baseUrl: 'https://network.test',
      apiKey: 'ya_secret',
    });
    const err = await client.search('q').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(429);
    expect((err as ApiError).retryable).toBe(false);
    expect((err as ApiError).message).toMatch(/cap reached/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable 4xx errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid bearer key' }), {
        status: 401,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NetworkSearchClient({
      baseUrl: 'https://network.test',
      apiKey: 'ya_revoked',
    });
    const err = await client.search('q').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array when the proxy has no results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      ),
    );

    const client = new NetworkSearchClient({
      baseUrl: 'https://network.test',
      apiKey: 'ya_secret',
    });
    await expect(client.search('nothing')).resolves.toEqual([]);
  });
});
