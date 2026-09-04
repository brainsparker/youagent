import { afterEach, describe, expect, it } from 'vitest';
import { A2AServer } from './a2a-server.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { Post } from '../types/post.js';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    agentId: 'agent',
    summary: 'Grid battery storage doubles in a year.',
    sourceUrls: ['https://example.test/grid'],
    sourceAttribution: 'example.test',
    timestamp: '2026-09-01T12:00:00.000Z',
    relevanceTags: ['batteries'],
    type: 'finding',
    ...overrides,
  };
}

const card = createAgentCard({
  handle: 'grid-watch',
  displayName: 'Grid Watch',
  interests: [{ topic: 'grid-scale batteries' }],
  cadence: '6h',
  url: 'https://grid.example.test',
});

let server: A2AServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

async function startServer(config: ConstructorParameters<typeof A2AServer>[0]): Promise<string> {
  server = new A2AServer({ ...config, port: 0 });
  await server.start();
  return `http://127.0.0.1:${server.listeningPort}`;
}

describe('A2AServer feed routes', () => {
  it('returns 404 for feed paths when no feed is configured', async () => {
    const base = await startServer({ agentCard: card });
    const res = await fetch(`${base}/feed.xml`);
    expect(res.status).toBe(404);
  });

  it('serves an Atom feed at /feed.xml with the agent card metadata', async () => {
    const base = await startServer({
      agentCard: card,
      feed: { getPosts: () => [makePost()] },
    });

    const res = await fetch(`${base}/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');

    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<title>@grid-watch</title>');
    expect(xml).toContain(`<subtitle>${card.description}</subtitle>`);
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://grid.example.test/feed.xml"/>');
    expect(xml).toContain('<title>Grid battery storage doubles in a year.</title>');
  });

  it('serves a JSON Feed at /feed.json', async () => {
    const base = await startServer({
      agentCard: card,
      feed: { getPosts: async () => [makePost()], title: 'Grid Watch findings' },
    });

    const res = await fetch(`${base}/feed.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/feed+json; charset=utf-8');

    const feed = await res.json();
    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.title).toBe('Grid Watch findings');
    expect(feed.feed_url).toBe('https://grid.example.test/feed.json');
    expect(feed.home_page_url).toBe('https://grid.example.test');
    expect(feed.items[0].url).toBe('https://example.test/grid');
  });

  it('passes a bounded ?limit= to getPosts and trims the response', async () => {
    const seen: number[] = [];
    const posts = Array.from({ length: 5 }, (_, i) =>
      makePost({ id: `0000000${i}-0000-4000-8000-000000000000`, summary: `post ${i}` }),
    );
    const base = await startServer({
      agentCard: card,
      feed: {
        getPosts: (limit) => {
          seen.push(limit);
          return posts;
        },
      },
    });

    const res = await fetch(`${base}/feed.json?limit=2`);
    const feed = await res.json();
    expect(seen).toEqual([2]);
    expect(feed.items).toHaveLength(2);

    await fetch(`${base}/feed.json?limit=abc`);
    expect(seen[1]).toBe(50);

    await fetch(`${base}/feed.json?limit=100000`);
    expect(seen[2]).toBe(500);
  });

  it('uses publicUrl for the self link when configured', async () => {
    const base = await startServer({
      agentCard: card,
      feed: { getPosts: () => [], publicUrl: 'https://public.example.test/agents/grid/' },
    });

    const xml = await (await fetch(`${base}/feed.xml`)).text();
    expect(xml).toContain('href="https://public.example.test/agents/grid/feed.xml"');
    expect(xml).not.toContain('<entry>');
  });

  it('returns 500 with a JSON error when getPosts throws', async () => {
    const base = await startServer({
      agentCard: card,
      feed: {
        getPosts: () => {
          throw new Error('database locked');
        },
      },
    });

    const res = await fetch(`${base}/feed.xml`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'database locked' });
  });

  it('keeps existing routes working alongside the feed', async () => {
    const base = await startServer({ agentCard: card, feed: { getPosts: () => [] } });

    expect((await fetch(`${base}/health`)).status).toBe(200);
    const cardRes = await fetch(`${base}/.well-known/agent.json`);
    expect(cardRes.status).toBe(200);
    expect((await cardRes.json()).name).toBe('Grid Watch');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
