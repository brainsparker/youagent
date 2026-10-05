import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import {
  MCP_CARD_RESOURCE_URI,
  MCP_FEED_RESOURCE_URI,
  MCP_TOOLS,
  YouAgentMcpServer,
  questionTerms,
} from './mcp-server.js';
import { MCP_ERROR_CODES, MCP_LATEST_PROTOCOL_VERSION } from './types.js';
import type { McpCallToolResult, McpJsonRpcResponse } from './types.js';
import { AgentDatabase } from '../storage/database.js';
import { PostRepo } from '../storage/post-repo.js';
import { FollowRepo } from '../storage/follow-repo.js';
import { KnowledgeGraph } from '../knowledge/knowledge-graph.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { Post } from '../types/post.js';
import type { SearchProvider, SearchResult } from '../client/types.js';

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [{ topic: 'carbon capture' }, { topic: 'grid-scale batteries', weight: 0.7 }],
  cadence: '6h',
  url: 'https://climate.example.com/a2a',
});
const agentId = card.youagent!.id;
const followedId = '33333333-3333-4333-8333-333333333333';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: uuidv4(),
    agentId,
    summary: 'Direct air capture pilot hits 1,000 tonnes per year.',
    sourceUrls: ['https://example.test/dac-pilot'],
    sourceAttribution: 'example.test',
    timestamp: '2026-09-01T12:00:00.000Z',
    relevanceTags: ['carbon-capture', 'dac'],
    type: 'finding',
    ...overrides,
  };
}

class FakeSearch implements SearchProvider {
  calls: Array<{ query: string; numResults?: number }> = [];
  fail = false;
  async search(query: string, options?: { numResults?: number }): Promise<SearchResult[]> {
    this.calls.push({ query, numResults: options?.numResults });
    if (this.fail) throw new Error('provider down');
    return [
      { title: 'Result A', url: 'https://a.test', snippet: 'snippet a', description: 'desc a', thumbnails: [] },
    ];
  }
  dispose(): void {}
}

function expectResult(res: McpJsonRpcResponse | McpJsonRpcResponse[] | null): Record<string, unknown> {
  expect(res).not.toBeNull();
  expect(Array.isArray(res)).toBe(false);
  const single = res as McpJsonRpcResponse;
  expect(single.error).toBeUndefined();
  return single.result as Record<string, unknown>;
}

function expectError(res: McpJsonRpcResponse | McpJsonRpcResponse[] | null): { code: number; message: string; data?: unknown } {
  const single = res as McpJsonRpcResponse;
  expect(single.error).toBeDefined();
  return single.error!;
}

describe('YouAgentMcpServer', () => {
  let db: AgentDatabase;
  let posts: PostRepo;
  let follows: FollowRepo;
  let graph: KnowledgeGraph;
  let search: FakeSearch;
  let server: YouAgentMcpServer;

  beforeEach(async () => {
    db = new AgentDatabase(':memory:');
    db.initialize();
    posts = new PostRepo(db.getDb());
    follows = new FollowRepo(db.getDb());
    graph = new KnowledgeGraph(db.getDb());
    search = new FakeSearch();

    // Own posts, newest first by timestamp, plus one from a followed agent.
    posts.save(makePost({ timestamp: '2026-09-01T12:00:00.000Z' }));
    posts.save(
      makePost({
        summary: 'Form Energy iron-air battery plant begins shipping to Great River Energy.',
        sourceUrls: ['https://example.test/iron-air'],
        relevanceTags: ['grid-storage', 'iron-air'],
        timestamp: '2026-09-03T09:00:00.000Z',
      }),
    );
    posts.save(
      makePost({
        summary: 'Response: the DAC cost curve is still above $400 per tonne.',
        type: 'respond',
        cites: 'some-post',
        timestamp: '2026-09-04T09:00:00.000Z',
      }),
    );
    posts.save(
      makePost({
        agentId: followedId,
        summary: 'Followed agent: Climeworks Mammoth plant reaches 36,000 tonne capacity.',
        relevanceTags: ['carbon-capture'],
        timestamp: '2026-09-05T09:00:00.000Z',
      }),
    );
    follows.follow(agentId, followedId);

    // Two findings ingested into the graph so Form Energy connects to Great River Energy.
    const kgPost = posts.search({ text: 'iron-air', limit: 1 })[0]!;
    await graph.ingestFinding(
      {
        title: 'Form Energy ships to Great River Energy',
        summary: 'Form Energy and Great River Energy begin the first iron-air deployment in Minnesota.',
        sourceUrl: 'https://example.test/iron-air',
        sourceAttribution: 'example.test',
        relevanceTags: ['iron-air'],
        interest: 'grid-scale batteries',
      },
      kgPost.id,
    );

    server = new YouAgentMcpServer({
      agentCard: card,
      postRepo: posts,
      followRepo: follows,
      knowledgeGraph: graph,
      searchProvider: search,
      serverInfo: { name: 'youagent', version: '9.9.9' },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('lifecycle', () => {
    it('negotiates the protocol version and reports capabilities and server info', async () => {
      const res = expectResult(
        await server.handleMessage({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      );
      expect(res['protocolVersion']).toBe('2025-06-18');
      expect(res['serverInfo']).toEqual({ name: 'youagent', version: '9.9.9' });
      expect(res['capabilities']).toEqual({
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      });
      expect(res['instructions']).toContain('@climate-watch');
      expect(res['instructions']).toContain('carbon capture, grid-scale batteries');
      expect(server.protocolVersion).toBe('2025-06-18');
    });

    it('answers with its newest version when the client asks for an unknown one', async () => {
      const res = expectResult(
        await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2031-01-01' } }),
      );
      expect(res['protocolVersion']).toBe(MCP_LATEST_PROTOCOL_VERSION);
    });

    it('answers ping with an empty result and ignores notifications', async () => {
      expect(await server.handleMessage({ jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual({
        jsonrpc: '2.0',
        id: 'p',
        result: {},
      });
      expect(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    });

    it('returns JSON-RPC errors for bad requests, unknown methods, and bad JSON', async () => {
      expect(expectError(await server.handleMessage({ id: 1, method: 'ping' })).code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
      expect(expectError(await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' })).code).toBe(
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
      );
      const parse = expectError(await server.handleLine('{not json'));
      expect(parse.code).toBe(MCP_ERROR_CODES.PARSE_ERROR);
      expect((await server.handleLine('{not json') as McpJsonRpcResponse).id).toBeNull();
    });

    it('handles a JSON-RPC batch for pre-2025-06-18 clients', async () => {
      const res = await server.handleMessage([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]);
      expect(Array.isArray(res)).toBe(true);
      const batch = res as McpJsonRpcResponse[];
      expect(batch.map((r) => r.id)).toEqual([1, 2]);
    });
  });

  describe('tools/list', () => {
    it('lists every tool with an object input schema and read-only annotations', async () => {
      const res = expectResult(await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      const tools = res['tools'] as Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }>;
      expect(tools.map((t) => t.name)).toEqual([
        'youagent_card',
        'youagent_feed',
        'youagent_search_posts',
        'youagent_entities',
        'youagent_connections',
        'youagent_search_web',
        'youagent_ask',
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.annotations.readOnlyHint).toBe(true);
      }
      expect(tools).toHaveLength(MCP_TOOLS.length);
    });
  });

  describe('tools/call', () => {
    async function call(name: string, args?: Record<string, unknown>): Promise<McpCallToolResult> {
      const res = expectResult(
        await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      );
      return res as unknown as McpCallToolResult;
    }

    it('youagent_card returns the agent card as structured content with a text mirror', async () => {
      const result = await call('youagent_card');
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as { card: { name: string } };
      expect(structured.card.name).toBe('Climate Watch');
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    });

    it('youagent_feed returns own and followed posts newest first, with filters', async () => {
      const all = (await call('youagent_feed')).structuredContent as { count: number; posts: Array<{ summary: string; type: string }> };
      expect(all.count).toBe(4);
      expect(all.posts[0]!.summary).toContain('Climeworks');

      const own = (await call('youagent_feed', { include_followed: false })).structuredContent as { count: number };
      expect(own.count).toBe(3);

      const responses = (await call('youagent_feed', { type: 'respond' })).structuredContent as { posts: Array<{ type: string }> };
      expect(responses.posts).toHaveLength(1);
      expect(responses.posts[0]!.type).toBe('respond');

      const recent = (await call('youagent_feed', { since: '2026-09-04T00:00:00Z' })).structuredContent as { count: number };
      expect(recent.count).toBe(2);

      const limited = (await call('youagent_feed', { limit: 1 })).structuredContent as { count: number };
      expect(limited.count).toBe(1);
    });

    it('youagent_search_posts matches summaries and tags case-insensitively and escapes wildcards', async () => {
      const byTag = (await call('youagent_search_posts', { query: 'IRON-AIR' })).structuredContent as { count: number };
      expect(byTag.count).toBe(1);

      const bySummary = (await call('youagent_search_posts', { query: 'climeworks' })).structuredContent as { count: number };
      expect(bySummary.count).toBe(1);

      const wildcard = (await call('youagent_search_posts', { query: '%' })).structuredContent as { count: number };
      expect(wildcard.count).toBe(0);
    });

    it('youagent_entities lists graph entities with connection counts and honors filters', async () => {
      const all = (await call('youagent_entities')).structuredContent as {
        count: number;
        entities: Array<{ name: string; type: string; connections: number }>;
      };
      expect(all.count).toBeGreaterThanOrEqual(2);
      const names = all.entities.map((e) => e.name);
      expect(names).toContain('Form Energy');
      expect(names).toContain('Great River Energy');
      expect(all.entities.every((e) => e.connections >= 1)).toBe(true);

      const filtered = (await call('youagent_entities', { query: 'great river' })).structuredContent as { entities: Array<{ name: string }> };
      expect(filtered.entities.map((e) => e.name)).toEqual(['Great River Energy']);

      const typed = (await call('youagent_entities', { type: 'location' })).structuredContent as { entities: Array<{ type: string }> };
      expect(typed.entities.every((e) => e.type === 'location')).toBe(true);
    });

    it('youagent_connections resolves an entity by name or id and returns neighbors and source posts', async () => {
      const byName = (await call('youagent_connections', { entity: 'form energy' })).structuredContent as {
        entity: { id: string; name: string };
        connections: Array<{ entity: { name: string }; relationshipType: string; postId: string }>;
        posts: Array<{ summary: string }>;
      };
      expect(byName.entity.name).toBe('Form Energy');
      expect(byName.connections.map((c) => c.entity.name)).toContain('Great River Energy');
      expect(byName.connections[0]!.relationshipType).toBe('co_occurrence');
      expect(byName.posts[0]!.summary).toContain('iron-air');

      const byId = (await call('youagent_connections', { entity: byName.entity.id })).structuredContent as { entity: { name: string } };
      expect(byId.entity.name).toBe('Form Energy');
    });

    it('youagent_connections reports an unknown entity as a tool error, not a protocol error', async () => {
      const result = await call('youagent_connections', { entity: 'nobody' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('nobody');
    });

    it('youagent_search_web uses the configured provider and surfaces provider failures as tool errors', async () => {
      const ok = await call('youagent_search_web', { query: 'iron-air batteries', limit: 3 });
      expect(ok.isError).toBeUndefined();
      expect(search.calls).toEqual([{ query: 'iron-air batteries', numResults: 3 }]);
      expect((ok.structuredContent as { results: Array<{ url: string }> }).results[0]!.url).toBe('https://a.test');

      search.fail = true;
      const failed = await call('youagent_search_web', { query: 'x' });
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain('provider down');
    });

    it('youagent_search_web explains how to enable search when no provider is configured', async () => {
      const offline = new YouAgentMcpServer({ agentCard: card, postRepo: posts, followRepo: follows, knowledgeGraph: graph });
      const res = expectResult(
        await offline.handleMessage({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'youagent_search_web', arguments: { query: 'x' } },
        }),
      ) as unknown as McpCallToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('YDC_API_KEY');
    });

    it('youagent_ask returns graph matches and a live answer when an answer provider exists', async () => {
      const graphOnly = (await call('youagent_ask', { question: 'What is Form Energy doing?' })).structuredContent as {
        knowledgeGraph: { count: number };
        answer: unknown;
        note?: string;
      };
      expect(graphOnly.knowledgeGraph.count).toBeGreaterThanOrEqual(1);
      expect(graphOnly.answer).toBeNull();
      expect(graphOnly.note).toContain('YDC_API_KEY');

      const withAnswers = new YouAgentMcpServer({
        agentCard: card,
        postRepo: posts,
        followRepo: follows,
        knowledgeGraph: graph,
        answerProvider: {
          answer: async (q) => ({ answer: `Answer to ${q}`, sources: [{ title: 'S', url: 'https://s.test', snippet: 's' }] }),
        },
      });
      const res = expectResult(
        await withAnswers.handleMessage({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'youagent_ask', arguments: { question: 'Form Energy?' } },
        }),
      ) as unknown as McpCallToolResult;
      const structured = res.structuredContent as { answer: { text: string; sources: unknown[] }; note?: string };
      expect(structured.answer.text).toBe('Answer to Form Energy?');
      expect(structured.answer.sources).toHaveLength(1);
      expect(structured.note).toBeUndefined();
    });

    it('rejects unknown tools and invalid arguments with InvalidParams', async () => {
      const unknown = expectError(
        await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }),
      );
      expect(unknown.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);

      const invalid = expectError(
        await server.handleMessage({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'youagent_feed', arguments: { limit: 0, type: 'other' } },
        }),
      );
      expect(invalid.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
      const issues = (invalid.data as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
      expect(issues).toContain('limit');
      expect(issues).toContain('type');
    });
  });

  describe('questionTerms', () => {
    it('keeps meaningful lowercase terms and drops stopwords, short tokens, and duplicates', () => {
      expect(questionTerms('What is Form Energy doing with Great River Energy?')).toEqual([
        'form',
        'energy',
        'great',
        'river',
      ]);
      expect(questionTerms('is it?')).toEqual([]);
    });
  });

  describe('resources', () => {
    it('lists the card and feed resources and reads them back', async () => {
      const list = expectResult(await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }));
      const uris = (list['resources'] as Array<{ uri: string }>).map((r) => r.uri);
      expect(uris).toEqual([MCP_CARD_RESOURCE_URI, MCP_FEED_RESOURCE_URI]);

      const cardRead = expectResult(
        await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: MCP_CARD_RESOURCE_URI } }),
      );
      const cardContents = (cardRead['contents'] as Array<{ mimeType: string; text: string }>)[0]!;
      expect(cardContents.mimeType).toBe('application/json');
      expect(JSON.parse(cardContents.text).name).toBe('Climate Watch');

      const feedRead = expectResult(
        await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: MCP_FEED_RESOURCE_URI } }),
      );
      const feedContents = (feedRead['contents'] as Array<{ mimeType: string; text: string }>)[0]!;
      expect(feedContents.mimeType).toBe('application/feed+json');
      const feed = JSON.parse(feedContents.text) as { version: string; items: unknown[] };
      expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
      // Own posts only: the followed agent's post is not in this agent's feed.
      expect(feed.items).toHaveLength(3);
    });

    it('rejects unknown resource URIs with InvalidParams', async () => {
      const err = expectError(
        await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'youagent://nope' } }),
      );
      expect(err.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
    });
  });

  describe('stdio framing', () => {
    it('reads one JSON message per line and writes one response per line', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

      const done = server.attach(input, output);
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
      input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      input.write('\n');
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\r\n');
      input.write('this is not json\n');
      input.end();
      await done;

      const lines = chunks.join('').split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(3);
      // Responses correlate by id; the spec allows them in any order.
      const responses = lines.map((l) => JSON.parse(l) as McpJsonRpcResponse);
      const byId = (id: number | null) => responses.find((r) => r.id === id)!;
      expect((byId(1).result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26');
      expect((byId(2).result as { tools: unknown[] }).tools).toHaveLength(MCP_TOOLS.length);
      expect(byId(null).error!.code).toBe(MCP_ERROR_CODES.PARSE_ERROR);
      // No embedded newlines inside any message.
      for (const line of lines) expect(line).not.toContain('\n');
    });
  });
});
