import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkPusher, postToPushPost } from './pusher.js';
import { RegistryClient } from './registry-client.js';
import type { Post } from '../types/post.js';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    agentId: 'local-agent',
    summary: 'A finding about carbon capture.',
    sourceUrls: ['https://example.test/article'],
    sourceAttribution: 'example.test',
    timestamp: '2026-07-09T00:00:00.000Z',
    relevanceTags: ['carbon', 'capture'],
    type: 'finding',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postToPushPost', () => {
  it('maps a post to the registry push shape', () => {
    expect(postToPushPost(makePost())).toEqual({
      summary: 'A finding about carbon capture.',
      url: 'https://example.test/article',
      tags: ['carbon', 'capture'],
    });
  });

  it('skips posts without a source URL', () => {
    expect(postToPushPost(makePost({ sourceUrls: [] }))).toBeNull();
  });

  it('skips posts with a non-http source URL', () => {
    expect(postToPushPost(makePost({ sourceUrls: ['ftp://x.test'] }))).toBeNull();
  });

  it('skips posts whose URL the registry would reject as malformed', () => {
    // One bad URL 400s a whole pushed batch server-side, so the client
    // filter must be at least as strict as the server's URL validation.
    expect(postToPushPost(makePost({ sourceUrls: ['https://exa mple.com/x'] }))).toBeNull();
    expect(postToPushPost(makePost({ sourceUrls: ['https://'] }))).toBeNull();
    expect(postToPushPost(makePost({ sourceUrls: ['http://'] }))).toBeNull();
  });

  it('skips posts with an empty summary', () => {
    expect(postToPushPost(makePost({ summary: '   ' }))).toBeNull();
  });

  it('trims oversized fields to the registry limits', () => {
    const post = makePost({
      summary: 'x'.repeat(3000),
      relevanceTags: Array.from({ length: 15 }, (_, i) => `tag-${i}`.repeat(20)),
    });
    const mapped = postToPushPost(post);

    expect(mapped?.summary).toHaveLength(2000);
    expect(mapped?.tags).toHaveLength(10);
    for (const tag of mapped?.tags ?? []) {
      expect(tag.length).toBeLessThanOrEqual(80);
    }
  });

  it('omits tags when none survive trimming', () => {
    const mapped = postToPushPost(makePost({ relevanceTags: [] }));
    expect(mapped).not.toHaveProperty('tags');
  });
});

describe('NetworkPusher', () => {
  it('pushes mappable posts and skips the rest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1, received: 1 }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({
      baseUrl: 'https://network.test',
      apiKey: 'ya_secret',
    });
    const pusher = new NetworkPusher(client, 'external-abc');

    const result = await pusher.push([makePost(), makePost({ sourceUrls: [] })]);

    expect(result).toEqual({ accepted: 1, received: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.posts).toHaveLength(1);
  });

  it('returns zeros without a network call when nothing is mappable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new RegistryClient({
      baseUrl: 'https://network.test',
      apiKey: 'ya_secret',
    });
    const pusher = new NetworkPusher(client, 'external-abc');

    await expect(pusher.push([makePost({ sourceUrls: [] })])).resolves.toEqual({
      accepted: 0,
      received: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds a working pusher from credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1, received: 1 }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pusher = NetworkPusher.fromCredentials({
      baseUrl: 'https://network.test',
      agentId: 'external-abc',
      handle: 'climate-watch',
      apiKey: 'ya_secret',
      createdAt: '',
    });
    await pusher.push([makePost()]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://network.test/api/v1/agents/external-abc/posts');
    expect(init.headers['Authorization']).toBe('Bearer ya_secret');
  });
});
