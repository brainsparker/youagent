import { describe, expect, it } from 'vitest';
import {
  buildJsonFeed,
  latestTimestamp,
  parseFeedLimit,
  postTitle,
  renderAtomFeed,
  renderJsonFeed,
  toFeedId,
  type FeedOptions,
} from './feed.js';
import type { Post } from '../types/post.js';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    agentId: '22222222-2222-4222-8222-222222222222',
    summary: 'Direct air capture pilot hits 1,000 tonnes per year.',
    sourceUrls: ['https://example.test/dac-pilot'],
    sourceAttribution: 'example.test',
    timestamp: '2026-09-01T12:00:00.000Z',
    relevanceTags: ['carbon-capture', 'dac'],
    type: 'finding',
    ...overrides,
  };
}

const options: FeedOptions = {
  siteUrl: 'https://agents.example.test/climate-watch',
  feedUrl: 'https://agents.example.test/climate-watch/feed.xml',
  agentHandle: 'climate-watch',
  agentId: '22222222-2222-4222-8222-222222222222',
  description: 'Tracks carbon removal news.',
};

describe('toFeedId', () => {
  it('turns UUIDs into urn:uuid IRIs', () => {
    expect(toFeedId('11111111-1111-4111-8111-111111111111', 'https://x.test')).toBe(
      'urn:uuid:11111111-1111-4111-8111-111111111111',
    );
  });

  it('passes URLs through and anchors anything else to the site URL', () => {
    expect(toFeedId('https://other.test/agent', 'https://x.test')).toBe('https://other.test/agent');
    expect(toFeedId('local agent', 'https://x.test/')).toBe('https://x.test/#local%20agent');
  });
});

describe('postTitle', () => {
  it('uses the first non-empty line', () => {
    expect(postTitle(makePost({ summary: '\n\nFirst line.\nSecond line.' }))).toBe('First line.');
  });

  it('truncates long summaries at a word boundary', () => {
    const long = 'word '.repeat(60).trim();
    const title = postTitle(makePost({ summary: long }));
    expect(title.length).toBeLessThanOrEqual(124);
    expect(title.endsWith('...')).toBe(true);
    expect(title).not.toContain('  ');
  });

  it('falls back for empty summaries', () => {
    expect(postTitle(makePost({ summary: '   ' }))).toBe('(untitled)');
  });
});

describe('latestTimestamp', () => {
  it('returns the newest post time and ignores unparseable values', () => {
    const posts = [
      makePost({ timestamp: '2026-08-01T00:00:00.000Z' }),
      makePost({ timestamp: 'not a date' }),
      makePost({ timestamp: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(latestTimestamp(posts, '2026-01-01T00:00:00.000Z')).toBe('2026-09-02T00:00:00.000Z');
  });

  it('uses the fallback when there are no posts', () => {
    expect(latestTimestamp([], '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('parseFeedLimit', () => {
  it('defaults, bounds, and rejects junk', () => {
    expect(parseFeedLimit(null)).toBe(50);
    expect(parseFeedLimit('10')).toBe(10);
    expect(parseFeedLimit('0')).toBe(50);
    expect(parseFeedLimit('-3')).toBe(50);
    expect(parseFeedLimit('abc')).toBe(50);
    expect(parseFeedLimit('99999')).toBe(500);
    expect(parseFeedLimit(undefined, 7)).toBe(7);
  });
});

describe('renderAtomFeed', () => {
  it('renders a well formed Atom 1.0 document with feed level metadata', () => {
    const xml = renderAtomFeed([makePost()], options);

    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true);
    expect(xml).toContain('<id>urn:uuid:22222222-2222-4222-8222-222222222222</id>');
    expect(xml).toContain('<title>@climate-watch</title>');
    expect(xml).toContain('<subtitle>Tracks carbon removal news.</subtitle>');
    expect(xml).toContain('<updated>2026-09-01T12:00:00.000Z</updated>');
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://agents.example.test/climate-watch/feed.xml"/>',
    );
    expect(xml).toContain('<link rel="alternate" type="text/html" href="https://agents.example.test/climate-watch"/>');
    expect(xml).toContain('<name>@climate-watch</name>');
    expect(xml.trimEnd().endsWith('</feed>')).toBe(true);
  });

  it('renders one entry per post with id, link, categories, and text content', () => {
    const xml = renderAtomFeed([makePost()], options);

    expect(xml).toContain('<id>urn:uuid:11111111-1111-4111-8111-111111111111</id>');
    expect(xml).toContain('<title>Direct air capture pilot hits 1,000 tonnes per year.</title>');
    expect(xml).toContain('<published>2026-09-01T12:00:00.000Z</published>');
    expect(xml).toContain('<link rel="alternate" href="https://example.test/dac-pilot"/>');
    expect(xml).toContain('<category term="carbon-capture"/>');
    expect(xml).toContain('<category term="dac"/>');
    expect(xml).toContain('<category term="youagent:finding" label="finding"/>');
    expect(xml).toContain('<content type="text">Direct air capture pilot hits 1,000 tonnes per year.\n\nSource: example.test</content>');
  });

  it('escapes XML special characters and strips control characters', () => {
    const xml = renderAtomFeed(
      [makePost({ summary: 'Tom & Jerry <b>"quoted"</b> \u0001bell', relevanceTags: ['a&b'] })],
      { ...options, title: 'Feed <1>' },
    );

    expect(xml).toContain('<title>Feed &lt;1&gt;</title>');
    expect(xml).toContain('Tom &amp; Jerry &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; bell');
    expect(xml).toContain('<category term="a&amp;b"/>');
    expect(xml).not.toContain('\u0001');
  });

  it('orders entries newest first and skips non-http links', () => {
    const older = makePost({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timestamp: '2026-08-01T00:00:00.000Z', summary: 'older' });
    const newer = makePost({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      timestamp: '2026-08-02T00:00:00.000Z',
      summary: 'newer',
      sourceUrls: ['ftp://nope.test/x', 'https://ok.test/a', 'https://ok.test/b'],
    });
    const xml = renderAtomFeed([older, newer], options);

    expect(xml.indexOf('<title>newer</title>')).toBeLessThan(xml.indexOf('<title>older</title>'));
    expect(xml).toContain('<link rel="alternate" href="https://ok.test/a"/>');
    expect(xml).toContain('<link rel="via" href="https://ok.test/b"/>');
    expect(xml).not.toContain('ftp://nope.test/x"/>');
  });

  it('renders an empty feed with a fallback updated time', () => {
    const xml = renderAtomFeed([], { ...options, updated: '2026-09-04T00:00:00.000Z' });
    expect(xml).toContain('<updated>2026-09-04T00:00:00.000Z</updated>');
    expect(xml).not.toContain('<entry>');
  });
});

describe('renderJsonFeed', () => {
  it('produces a JSON Feed 1.1 document', () => {
    const feed = JSON.parse(renderJsonFeed([makePost()], options));

    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.title).toBe('@climate-watch');
    expect(feed.home_page_url).toBe('https://agents.example.test/climate-watch');
    expect(feed.feed_url).toBe('https://agents.example.test/climate-watch/feed.xml');
    expect(feed.description).toBe('Tracks carbon removal news.');
    expect(feed.authors).toEqual([{ name: '@climate-watch', url: 'https://agents.example.test/climate-watch' }]);
    expect(feed.items).toHaveLength(1);

    const item = feed.items[0];
    expect(item.id).toBe('urn:uuid:11111111-1111-4111-8111-111111111111');
    expect(item.url).toBe('https://example.test/dac-pilot');
    expect(item.title).toBe('Direct air capture pilot hits 1,000 tonnes per year.');
    expect(item.date_published).toBe('2026-09-01T12:00:00.000Z');
    expect(item.tags).toEqual(['carbon-capture', 'dac']);
    expect(item._youagent).toEqual({
      type: 'finding',
      agent_id: '22222222-2222-4222-8222-222222222222',
      source_urls: ['https://example.test/dac-pilot'],
      source_attribution: 'example.test',
    });
  });

  it('omits optional fields that have no value and carries cites for responses', () => {
    const feed = buildJsonFeed(
      [makePost({ sourceUrls: [], relevanceTags: [], type: 'respond', cites: 'parent-post' })],
      { siteUrl: 'https://x.test', agentHandle: 'h', agentId: 'not-a-uuid' },
    );

    expect(feed.feed_url).toBeUndefined();
    expect(feed.description).toBeUndefined();
    expect(feed.items[0].url).toBeUndefined();
    expect(feed.items[0].tags).toBeUndefined();
    expect(feed.items[0]._youagent.cites).toBe('parent-post');
    expect(feed.items[0]._youagent.type).toBe('respond');
  });

  it('ends with a newline so it can be written straight to a file', () => {
    expect(renderJsonFeed([], options).endsWith('}\n')).toBe(true);
  });
});
