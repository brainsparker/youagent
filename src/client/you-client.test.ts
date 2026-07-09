import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouSearchClient } from './you-client.js';

let client: YouSearchClient | undefined;

afterEach(() => {
  client?.dispose();
  client = undefined;
  vi.unstubAllGlobals();
});

describe('YouSearchClient.search', () => {
  it('hits /v1/search and parses the { results: { news, web } } envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            news: [
              { title: 'News hit', url: 'https://news.test', description: 'breaking' },
            ],
            web: [
              {
                title: 'Web hit',
                url: 'https://web.test',
                snippets: ['first snippet'],
                description: 'fallback',
              },
              { url: 'https://no-title.test' },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    client = new YouSearchClient({ apiKey: 'ydc-key' });
    const results = await client.search('carbon capture', { numResults: 5 });

    expect(results).toEqual([
      {
        title: 'News hit',
        url: 'https://news.test',
        snippet: 'breaking',
        description: 'breaking',
        thumbnails: [],
      },
      {
        title: 'Web hit',
        url: 'https://web.test',
        snippet: 'first snippet',
        description: 'fallback',
        thumbnails: [],
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ydc-index.io/v1/search?query=carbon+capture&count=5');
    expect(init.headers['X-API-Key']).toBe('ydc-key');
  });

  it('still parses the legacy hits envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            hits: [
              {
                title: 'Legacy',
                url: 'https://legacy.test',
                description: 'old shape',
                snippets: ['legacy snippet'],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    client = new YouSearchClient({ apiKey: 'ydc-key' });
    const results = await client.search('query');

    expect(results).toEqual([
      {
        title: 'Legacy',
        url: 'https://legacy.test',
        snippet: 'legacy snippet',
        description: 'old shape',
        thumbnails: [],
      },
    ]);
  });
});
