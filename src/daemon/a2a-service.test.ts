import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentA2AService } from './a2a-service.js';
import { AgentDatabase } from '../storage/database.js';
import { PostRepo } from '../storage/post-repo.js';
import { FollowRepo } from '../storage/follow-repo.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import { getAgentIdentifier, type AgentCard } from '../types/agent-card.js';
import type { Post } from '../types/post.js';

let tempDir: string;
let dbPath: string;
let card: AgentCard;
let agentId: string;
let service: AgentA2AService | undefined;
let base = '';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: crypto.randomUUID(),
    agentId,
    summary: 'Grid battery storage doubles in a year.',
    sourceUrls: ['https://example.test/grid'],
    sourceAttribution: 'example.test',
    timestamp: '2026-09-01T12:00:00.000Z',
    relevanceTags: ['batteries'],
    type: 'finding',
    ...overrides,
  };
}

/** Write posts through a second connection, the way the daemon would. */
function savePosts(posts: Post[]): void {
  const writer = new AgentDatabase(dbPath);
  writer.initialize();
  const repo = new PostRepo(writer.getDb());
  for (const post of posts) {
    repo.save(post);
  }
  writer.close();
}

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function dataMessage(data: Record<string, unknown>): unknown {
  return {
    message: {
      kind: 'message',
      role: 'user',
      messageId: crypto.randomUUID(),
      parts: [{ kind: 'data', data }],
    },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'youagent-a2a-service-'));
  dbPath = join(tempDir, 'youagent.db');
  card = createAgentCard({
    handle: 'grid-watch',
    displayName: 'Grid Watch',
    interests: [{ topic: 'grid-scale batteries' }],
    cadence: '6h',
    url: 'http://localhost:3141',
  });
  agentId = getAgentIdentifier(card).id;

  service = new AgentA2AService({ agentCard: card, dbPath, port: 0 });
  const port = await service.start();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (service) {
    await service.stop();
    service = undefined;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentA2AService', () => {
  it('serves the agent card at the A2A v1.0 discovery path', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/a2a+json');
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('Grid Watch');
  });

  it('serves the health check', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it('serves posts from the local database as Atom and JSON Feed', async () => {
    savePosts([makePost()]);

    const atom = await fetch(`${base}/feed.xml`);
    expect(atom.status).toBe(200);
    expect(await atom.text()).toContain('Grid battery storage doubles in a year.');

    const jsonFeed = await fetch(`${base}/feed.json`);
    expect(jsonFeed.status).toBe(200);
    const feed = (await jsonFeed.json()) as { items: Array<{ title?: string; content_text?: string }> };
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.content_text ?? feed.items[0]?.title).toContain(
      'Grid battery storage doubles in a year.',
    );
  });

  it('answers youagent/posts-request with stored posts, honoring since', async () => {
    savePosts([
      makePost({ summary: 'Old finding', timestamp: '2026-08-01T12:00:00.000Z' }),
      makePost({ summary: 'New finding', timestamp: '2026-09-01T12:00:00.000Z' }),
    ]);

    const body = await rpc(
      'message/send',
      dataMessage({ type: 'youagent/posts-request', since: '2026-08-15T00:00:00.000Z' }),
    );

    const task = body.result as {
      status: { state: string };
      artifacts?: Array<{ parts: Array<{ kind: string; data?: { type: string; posts: Post[] } }> }>;
    };
    expect(task.status.state).toBe('completed');
    const payload = task.artifacts
      ?.flatMap((a) => a.parts)
      .find((p) => p.kind === 'data' && p.data?.type === 'youagent/posts-response');
    expect(payload).toBeDefined();
    expect(payload?.data?.posts.map((p) => p.summary)).toEqual(['New finding']);
  });

  it('clamps the posts-request limit', async () => {
    savePosts([
      makePost({ summary: 'One', timestamp: '2026-09-03T12:00:00.000Z' }),
      makePost({ summary: 'Two', timestamp: '2026-09-02T12:00:00.000Z' }),
      makePost({ summary: 'Three', timestamp: '2026-09-01T12:00:00.000Z' }),
    ]);

    const body = await rpc('message/send', dataMessage({ type: 'youagent/posts-request', limit: 2 }));
    const task = body.result as {
      artifacts?: Array<{ parts: Array<{ kind: string; data?: { posts: Post[] } }> }>;
    };
    const posts = task.artifacts?.flatMap((a) => a.parts).find((p) => p.kind === 'data')?.data?.posts;
    // Newest first, limited to 2.
    expect(posts?.map((p) => p.summary)).toEqual(['One', 'Two']);
  });

  it('records incoming follows and unfollows in the follow graph', async () => {
    const follow = await rpc(
      'message/send',
      dataMessage({ type: 'youagent/follow', agentId: 'remote-agent-1', handle: 'remote-one' }),
    );
    expect((follow.result as { status: { state: string } }).status.state).toBe('completed');

    const reader = new AgentDatabase(dbPath);
    reader.initialize();
    const followRepo = new FollowRepo(reader.getDb());
    expect(followRepo.getFollowers(agentId)).toContain('remote-agent-1');

    await rpc('message/send', dataMessage({ type: 'youagent/unfollow', agentId: 'remote-agent-1' }));
    expect(followRepo.getFollowers(agentId)).not.toContain('remote-agent-1');
    reader.close();
  });

  it('rejects when the port is already in use; stop() still releases the database', async () => {
    const takenPort = new URL(base).port;
    const other = new AgentA2AService({ agentCard: card, dbPath, port: Number(takenPort) });
    await expect(other.start()).rejects.toThrow(/EADDRINUSE|listen/);
    await expect(other.stop()).resolves.toBeUndefined();
    // The first service is unaffected.
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});
