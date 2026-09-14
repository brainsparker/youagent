/**
 * Syndication feeds for an agent's posts.
 *
 * A Progressive Web Agent should be readable by the plain old web, not only
 * by other agents over A2A. These renderers turn the posts an agent has
 * published into two open, widely supported formats:
 *
 * - Atom 1.0 (RFC 4287), understood by every feed reader and aggregator
 * - JSON Feed 1.1 (https://www.jsonfeed.org/version/1.1/), the JSON native
 *   equivalent, with youagent specific fields carried in a `_youagent`
 *   extension object as the spec allows
 *
 * Both renderers are pure functions with no I/O so they can back the A2A
 * server's `/feed.xml` and `/feed.json` routes, the `youagent feed --format`
 * flag, or a static site build.
 */

import type { Post } from '../types/post.js';

/** Metadata describing the agent whose posts are being syndicated. */
export interface FeedOptions {
  /** Feed title. Defaults to the agent handle. */
  title?: string;
  /** Short description, shown as the Atom subtitle and JSON Feed description. */
  description?: string;
  /** Public URL of the agent (agent card `url`). Used as the feed's home page. */
  siteUrl: string;
  /** Absolute URL this feed is served from, when known. */
  feedUrl?: string;
  /** Agent handle, rendered without the leading `@`. */
  agentHandle: string;
  /** Stable agent identifier, used to build the feed id. */
  agentId: string;
  /** Override the feed's `updated` timestamp. Defaults to the newest post. */
  updated?: string;
}

/** Media type for Atom responses. */
export const ATOM_CONTENT_TYPE = 'application/atom+xml; charset=utf-8';

/** Media type for JSON Feed responses. */
export const JSON_FEED_CONTENT_TYPE = 'application/feed+json; charset=utf-8';

/** Default number of posts a feed carries. */
export const DEFAULT_FEED_LIMIT = 50;

/** Hard ceiling for `?limit=` on the served feeds. */
export const MAX_FEED_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Title length cap for entries, applied at a word boundary. */
const TITLE_MAX = 120;

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Build a stable, globally unique identifier for a feed or entry.
 * UUIDs become `urn:uuid:` IRIs, anything else falls back to a tag or URL.
 */
export function toFeedId(id: string, fallbackUrl: string): string {
  if (UUID_RE.test(id)) return `urn:uuid:${id.toLowerCase()}`;
  if (/^https?:\/\//i.test(id)) return id;
  return `${fallbackUrl.replace(/\/+$/, '')}/#${encodeURIComponent(id)}`;
}

/** Derive a one line title from a post summary. */
export function postTitle(post: Post): string {
  const firstLine = post.summary.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const text = firstLine.trim();
  if (text.length <= TITLE_MAX) return text || '(untitled)';
  const cut = text.slice(0, TITLE_MAX);
  const atWord = cut.lastIndexOf(' ');
  return (atWord > TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd() + '...';
}

/** First http(s) source URL of a post, if any. */
export function primarySourceUrl(post: Post): string | undefined {
  return post.sourceUrls.find((u) => /^https?:\/\//i.test(u));
}

/** Normalise a timestamp to RFC 3339. Invalid input falls back to the epoch. */
export function toRfc3339(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** Newest post timestamp, or `fallback` when there are no posts. */
export function latestTimestamp(posts: Post[], fallback: string): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const post of posts) {
    const t = new Date(post.timestamp).getTime();
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : toRfc3339(fallback);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most C0 control characters; strip them rather than emit an invalid document.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function sortNewestFirst(posts: Post[]): Post[] {
  return [...posts].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function feedTitle(opts: FeedOptions): string {
  return opts.title ?? `@${opts.agentHandle}`;
}

/** Plain text body of an entry: the summary plus a source attribution line. */
function entryText(post: Post): string {
  const lines = [post.summary.trim()];
  if (post.sourceAttribution) lines.push('', `Source: ${post.sourceAttribution}`);
  if (post.sourceUrls.length > 1) {
    lines.push('', 'All sources:');
    for (const url of post.sourceUrls) lines.push(`- ${url}`);
  }
  return lines.join('\n');
}

// ── Atom 1.0 ───────────────────────────────────────────────────────────────

/**
 * Render posts as an Atom 1.0 feed document.
 * Posts are emitted newest first regardless of input order.
 */
export function renderAtomFeed(posts: Post[], opts: FeedOptions): string {
  const sorted = sortNewestFirst(posts);
  const now = new Date().toISOString();
  const updated = opts.updated ? toRfc3339(opts.updated) : latestTimestamp(sorted, now);
  const feedId = toFeedId(opts.agentId, opts.siteUrl);

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(feedId)}</id>`,
    `  <title>${escapeXml(feedTitle(opts))}</title>`,
  ];
  if (opts.description) lines.push(`  <subtitle>${escapeXml(opts.description)}</subtitle>`);
  lines.push(`  <updated>${updated}</updated>`);
  lines.push(`  <link rel="alternate" type="text/html" href="${escapeXml(opts.siteUrl)}"/>`);
  if (opts.feedUrl) {
    lines.push(
      `  <link rel="self" type="application/atom+xml" href="${escapeXml(opts.feedUrl)}"/>`,
    );
  }
  lines.push(
    '  <author>',
    `    <name>@${escapeXml(opts.agentHandle)}</name>`,
    `    <uri>${escapeXml(opts.siteUrl)}</uri>`,
    '  </author>',
    '  <generator uri="https://github.com/brainsparker/youagent">youagent</generator>',
  );

  for (const post of sorted) {
    const source = primarySourceUrl(post);
    const published = toRfc3339(post.timestamp);
    lines.push('  <entry>');
    lines.push(`    <id>${escapeXml(toFeedId(post.id, opts.siteUrl))}</id>`);
    lines.push(`    <title>${escapeXml(postTitle(post))}</title>`);
    lines.push(`    <published>${published}</published>`);
    lines.push(`    <updated>${published}</updated>`);
    if (source) {
      lines.push(`    <link rel="alternate" href="${escapeXml(source)}"/>`);
    }
    for (const url of post.sourceUrls) {
      if (url !== source && /^https?:\/\//i.test(url)) {
        lines.push(`    <link rel="via" href="${escapeXml(url)}"/>`);
      }
    }
    for (const tag of post.relevanceTags) {
      lines.push(`    <category term="${escapeXml(tag)}"/>`);
    }
    lines.push(`    <category term="youagent:${escapeXml(post.type)}" label="${escapeXml(post.type)}"/>`);
    lines.push(`    <content type="text">${escapeXml(entryText(post))}</content>`);
    lines.push('  </entry>');
  }

  lines.push('</feed>', '');
  return lines.join('\n');
}

// ── JSON Feed 1.1 ──────────────────────────────────────────────────────────

/** One JSON Feed item, with the youagent extension object. */
export interface JsonFeedItem {
  id: string;
  url?: string;
  title: string;
  content_text: string;
  date_published: string;
  tags?: string[];
  authors: Array<{ name: string; url?: string }>;
  _youagent: {
    type: Post['type'];
    agent_id: string;
    source_urls: string[];
    source_attribution: string;
    cites?: string;
  };
}

/** A JSON Feed 1.1 document. */
export interface JsonFeed {
  version: 'https://jsonfeed.org/version/1.1';
  title: string;
  home_page_url: string;
  feed_url?: string;
  description?: string;
  authors: Array<{ name: string; url?: string }>;
  items: JsonFeedItem[];
}

/** Map a single post to a JSON Feed item. */
export function postToJsonFeedItem(post: Post, opts: FeedOptions): JsonFeedItem {
  const source = primarySourceUrl(post);
  const item: JsonFeedItem = {
    id: toFeedId(post.id, opts.siteUrl),
    title: postTitle(post),
    content_text: entryText(post),
    date_published: toRfc3339(post.timestamp),
    authors: [{ name: `@${opts.agentHandle}`, url: opts.siteUrl }],
    _youagent: {
      type: post.type,
      agent_id: post.agentId,
      source_urls: post.sourceUrls,
      source_attribution: post.sourceAttribution,
    },
  };
  if (source) item.url = source;
  if (post.relevanceTags.length > 0) item.tags = post.relevanceTags;
  if (post.cites) item._youagent.cites = post.cites;
  return item;
}

/** Build the JSON Feed object (not yet serialised). */
export function buildJsonFeed(posts: Post[], opts: FeedOptions): JsonFeed {
  const sorted = sortNewestFirst(posts);
  const feed: JsonFeed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: feedTitle(opts),
    home_page_url: opts.siteUrl,
    authors: [{ name: `@${opts.agentHandle}`, url: opts.siteUrl }],
    items: sorted.map((p) => postToJsonFeedItem(p, opts)),
  };
  if (opts.feedUrl) feed.feed_url = opts.feedUrl;
  if (opts.description) feed.description = opts.description;
  return feed;
}

/** Render posts as a JSON Feed 1.1 document string. */
export function renderJsonFeed(posts: Post[], opts: FeedOptions): string {
  return JSON.stringify(buildJsonFeed(posts, opts), null, 2) + '\n';
}

/**
 * Parse a `limit` query value into a bounded positive integer.
 * Falls back to `DEFAULT_FEED_LIMIT` for missing or invalid input.
 */
export function parseFeedLimit(raw: string | null | undefined, fallback = DEFAULT_FEED_LIMIT): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_FEED_LIMIT);
}
