import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDaemon, withAgentUrl } from './agent-daemon.js';
import { AgentDatabase } from '../storage/database.js';
import { PostRepo } from '../storage/post-repo.js';
import { FollowRepo } from '../storage/follow-repo.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import { A2A_WELL_KNOWN_PATH, getAgentIdentifier, type AgentCard } from '../types/agent-card.js';
import type { SearchProvider } from '../client/types.js';
import type { JsonRpcResponse, Task } from '../a2a/types.js';
import type { Post } from '../types/post.js';

/** A search provider that finds nothing, so cycles never hit the network. */
function silentProvider(): SearchProvider {
  return {
    search: vi.fn(async () => []),
    dispose: vi.fn(),
  };
}

async function rpc(url: string, method: string, params?: unknown): Promise<JsonRpcResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'req', method, params }),
  });
  return (await res.json()) as JsonRpcResponse;
}

function makePost(agentId: string, summary: string, timestamp: string): Post {
  return {
    id: `post-${Math.random().toString(36).slice(2)}`,
    agentId,
    summary,
    sourceUrls: ['https://example.test/source'],
    sourceAttribution: 'example.test',
    timestamp,
    relevanceTags: ['testing'],
    type: 'finding',
  };
}

describe('withAgentUrl', () => {
  it('points the JSON-RPC interface and legacy url at the public URL', () => {
    const card = createAgentCard({
      handle: 'proxy-test',
      interests: [{ topic: 'a' }],
      cadence: '6h',
    }) as AgentCard;
    const served = withAgentUrl(card, 'https://agents.example.test/proxy/');
    expect(served.url).toBe('https://agents.example.test/proxy');
    expect(served.supportedInterfaces[0].url).toBe('https://agents.example.test/proxy');
    expect(served.supportedInterfaces[0].protocolBinding).toBe('JSONRPC');
    // The original card is untouched.
    expect(card.url).toBe('http://localhost:3141');
  });
});

describe('AgentDaemon serving A2A', () => {
  let dir: string;
  let cardPath: string;
  let dbPath: string;
  let card: AgentCard;
  let selfId: string;
  const quiet: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'youagent-daemon-'));
    cardPath = join(dir, 'agent-card.json');
    dbPath = join(dir, 'youagent.db');
    card = createAgentCard({
      handle: 'daemon-test',
      displayName: 'Daemon Test',
      interests: [{ topic: 'grid-scale batteries' }],
      cadence: '6h',
      capabilities: { pushNotifications: true },
    }) as AgentCard;
    selfId = getAgentIdentifier(card).id;
    await writeFile(cardPath, JSON.stringify(card, null, 2));
    // The daemon narrates its lifecycle; keep test output readable.
    quiet.push(vi.spyOn(console, 'log').mockImplementation(() => {}));
    quiet.push(vi.spyOn(console, 'warn').mockImplementation(() => {}));
  });

  afterEach(async () => {
    for (const spy of quiet.splice(0)) spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not serve unless asked', async () => {
    const daemon = new AgentDaemon({ searchClient: silentProvider(), agentCardPath: cardPath, dbPath });
    await daemon.start();
    try {
      expect(daemon.a2aServer).toBeNull();
      expect(daemon.serving).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

  it('serves the card, feeds, follow graph, and posts-request from the agent database', async () => {
    const provider = silentProvider();
    const daemon = new AgentDaemon({
      searchClient: provider,
      agentCardPath: cardPath,
      dbPath,
      serve: { port: 0, pushNotifications: { allowPrivateHosts: true } },
    });
    await daemon.start();

    try {
      const info = daemon.serving;
      expect(info).not.toBeNull();
      expect(info!.port).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${info!.port}`;

      // The initial search cycle ran through the injected provider.
      expect(provider.search).toHaveBeenCalled();

      // Card discovery at the v1.0 well-known path.
      const cardRes = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);
      expect(cardRes.status).toBe(200);
      expect(cardRes.headers.get('content-type')).toBe('application/a2a+json');
      const served = (await cardRes.json()) as AgentCard;
      expect(served.name).toBe('Daemon Test');
      expect(getAgentIdentifier(served).id).toBe(selfId);

      // Posts written to the agent database show up in the feeds.
      const sideDb = new AgentDatabase(dbPath);
      sideDb.initialize();
      const postRepo = new PostRepo(sideDb.getDb());
      postRepo.save(makePost(selfId, 'Old finding', '2026-09-01T00:00:00.000Z'));
      postRepo.save(makePost(selfId, 'New finding', '2026-09-28T00:00:00.000Z'));

      const feed = (await (await fetch(`${base}/feed.json`)).json()) as { items: Array<{ title: string }> };
      expect(feed.items.map((i) => i.title)).toEqual(['New finding', 'Old finding']);
      const atom = await (await fetch(`${base}/feed.xml`)).text();
      expect(atom).toContain('New finding');

      // A peer follows this agent: recorded as a follower in the follow graph.
      const follow = await rpc(base, 'message/send', {
        message: {
          role: 'user',
          messageId: 'follow-1',
          parts: [{ kind: 'data', data: { type: 'youagent/follow', agentId: 'peer-1', handle: 'peer' } }],
        },
      });
      expect(follow.error).toBeUndefined();
      expect((follow.result as Task).status.state).toBe('completed');
      const followRepo = new FollowRepo(sideDb.getDb());
      expect(followRepo.getFollowers(selfId)).toEqual(['peer-1']);

      // posts-request answers from the post repo and honors since/limit.
      const posts = await rpc(base, 'message/send', {
        message: {
          role: 'user',
          messageId: 'posts-1',
          parts: [{ kind: 'data', data: { type: 'youagent/posts-request', since: '2026-09-15T00:00:00.000Z' } }],
        },
      });
      const artifact = (posts.result as Task).artifacts?.[0];
      const data = artifact?.parts[0].kind === 'data' ? artifact.parts[0].data : undefined;
      expect((data as { posts: Post[] }).posts.map((p) => p.summary)).toEqual(['New finding']);

      // Unfollow removes the follower.
      await rpc(base, 'message/send', {
        message: {
          role: 'user',
          messageId: 'unfollow-1',
          parts: [{ kind: 'data', data: { type: 'youagent/unfollow', agentId: 'peer-1' } }],
        },
      });
      expect(followRepo.getFollowers(selfId)).toEqual([]);
      sideDb.close();
    } finally {
      await daemon.stop();
    }

    // The injected provider belongs to the caller and is not disposed.
    expect(provider.dispose).not.toHaveBeenCalled();
  });

  it('keeps A2A tasks across a daemon restart', async () => {
    const first = new AgentDaemon({
      searchClient: silentProvider(),
      agentCardPath: cardPath,
      dbPath,
      serve: { port: 0 },
    });
    await first.start();
    const firstBase = `http://127.0.0.1:${first.serving!.port}`;
    const created = (await rpc(firstBase, 'message/send', {
      message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'remember me' }] },
    })).result as Task;
    await first.stop();

    const second = new AgentDaemon({
      searchClient: silentProvider(),
      agentCardPath: cardPath,
      dbPath,
      serve: { port: 0 },
    });
    await second.start();
    try {
      const secondBase = `http://127.0.0.1:${second.serving!.port}`;
      const fetched = (await rpc(secondBase, 'tasks/get', { id: created.id })).result as Task;
      expect(fetched.id).toBe(created.id);
      expect(fetched.history?.[0].parts[0]).toEqual({ kind: 'text', text: 'remember me' });
    } finally {
      await second.stop();
    }
  });

  it('advertises the public URL on the served card and feed self links', async () => {
    const daemon = new AgentDaemon({
      searchClient: silentProvider(),
      agentCardPath: cardPath,
      dbPath,
      serve: { port: 0, publicUrl: 'https://agents.example.test/daemon-test/' },
    });
    await daemon.start();
    try {
      const info = daemon.serving!;
      expect(info.url).toBe('https://agents.example.test/daemon-test');
      expect(info.cardUrl).toBe(`https://agents.example.test/daemon-test${A2A_WELL_KNOWN_PATH}`);
      const base = `http://127.0.0.1:${info.port}`;
      const served = (await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json()) as AgentCard;
      expect(served.url).toBe('https://agents.example.test/daemon-test');
      expect(served.supportedInterfaces[0].url).toBe('https://agents.example.test/daemon-test');
      const feed = (await (await fetch(`${base}/feed.json`)).json()) as { feed_url: string };
      expect(feed.feed_url).toBe('https://agents.example.test/daemon-test/feed.json');
    } finally {
      await daemon.stop();
    }
  });

  it('re-points the served card at an explicit port that differs from the card URL', async () => {
    // Borrow a free port from the OS, then release it for the daemon.
    const probe = new AgentDaemon({
      searchClient: silentProvider(),
      agentCardPath: cardPath,
      dbPath: join(dir, 'probe.db'),
      serve: { port: 0 },
    });
    await probe.start();
    const freePort = probe.serving!.port;
    await probe.stop();

    const daemon = new AgentDaemon({
      searchClient: silentProvider(),
      agentCardPath: cardPath,
      dbPath,
      serve: { port: freePort },
    });
    await daemon.start();
    try {
      const info = daemon.serving!;
      expect(info.port).toBe(freePort);
      expect(info.url).toBe(`http://localhost:${freePort}`);
      const served = (await (await fetch(`http://127.0.0.1:${freePort}${A2A_WELL_KNOWN_PATH}`)).json()) as AgentCard;
      expect(served.url).toBe(`http://localhost:${freePort}`);
      expect(served.supportedInterfaces[0].url).toBe(`http://localhost:${freePort}`);
    } finally {
      await daemon.stop();
    }
  });

  it('fails fast and closes the database when the port is taken', async () => {
    const holder = new AgentDaemon({
      searchClient: silentProvider(),
      agentCardPath: cardPath,
      dbPath: join(dir, 'holder.db'),
      serve: { port: 0 },
    });
    await holder.start();
    const takenPort = holder.serving!.port;
    try {
      const daemon = new AgentDaemon({
        searchClient: silentProvider(),
        agentCardPath: cardPath,
        dbPath,
        serve: { port: takenPort },
      });
      await expect(daemon.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(daemon.isRunning()).toBe(false);
      expect(daemon.a2aServer).toBeNull();
    } finally {
      await holder.stop();
    }
  });
});
