/**
 * MCP server: expose a youagent to MCP clients over stdio.
 *
 * A2A is how agents talk to each other. MCP is how an assistant reaches
 * its tools and context. This module gives a running youagent the second
 * surface: Claude Code, Claude Desktop, Cursor, Windsurf, and any other MCP
 * client can read the agent card, browse and search the posts the agent has
 * published, walk its knowledge graph, run a web search through the same
 * provider the daemon uses, and ask the agent a question.
 *
 * The transport is the MCP stdio transport: newline-delimited JSON-RPC 2.0
 * on stdin/stdout. The server is implemented directly on the wire format,
 * the same way `A2AServer` implements A2A, so it adds no dependencies. Only
 * stdout carries protocol messages; anything else goes to stderr.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

import type { AgentCard } from '../types/agent-card.js';
import {
  getAgentIdentifier,
  getAgentUrl,
  getEffectiveInterests,
  isYouAgent,
} from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import type { PostRepo } from '../storage/post-repo.js';
import type { FollowRepo } from '../storage/follow-repo.js';
import type { KnowledgeGraph } from '../knowledge/knowledge-graph.js';
import type { EntityType, KnowledgeEntity, KnowledgeRelationship } from '../knowledge/types.js';
import type { AnswerResult, SearchProvider, SearchResult } from '../client/types.js';
import { JSON_FEED_CONTENT_TYPE, renderJsonFeed } from '../feed/feed.js';
import {
  MCP_ERROR_CODES,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpCallToolParams,
  type McpCallToolResult,
  type McpImplementation,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpJsonRpcError,
  type McpJsonRpcId,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpReadResourceParams,
  type McpReadResourceResult,
  type McpResource,
  type McpTool,
} from './types.js';

// ── Configuration ───────────────────────────────────────────────────────────

/** Anything that can answer a question with sources (YouSearchClient.answer). */
export interface AnswerProvider {
  answer(question: string): Promise<AnswerResult>;
}

/** Configuration for {@link YouAgentMcpServer}. */
export interface McpServerConfig {
  /** The agent being exposed. */
  agentCard: AgentCard;
  /** Post storage for the feed and post search tools. */
  postRepo: PostRepo;
  /** Follow graph, so the feed can include followed agents' posts. */
  followRepo: FollowRepo;
  /** Knowledge graph for the entity and connection tools. */
  knowledgeGraph: KnowledgeGraph;
  /**
   * Live web search. Optional: without it `youagent_search_web` returns a
   * tool error explaining how to enable search.
   */
  searchProvider?: SearchProvider;
  /**
   * Live answers for `youagent_ask`. Optional: without it the tool answers
   * from the knowledge graph alone.
   */
  answerProvider?: AnswerProvider;
  /** Reported in `serverInfo`. Defaults to `youagent` and `0.0.0`. */
  serverInfo?: Partial<McpImplementation>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Default number of posts returned by the feed and post search tools. */
export const MCP_DEFAULT_POST_LIMIT = 20;
/** Hard ceiling on posts per tool call. */
export const MCP_MAX_POST_LIMIT = 200;
/** Default number of entities returned by the entity tool. */
export const MCP_DEFAULT_ENTITY_LIMIT = 25;
/** Hard ceiling on entities per tool call. */
export const MCP_MAX_ENTITY_LIMIT = 500;
/** Hard ceiling on live web search results per tool call. */
export const MCP_MAX_SEARCH_LIMIT = 20;
/** Number of posts in the `youagent://feed.json` resource. */
export const MCP_FEED_RESOURCE_LIMIT = 50;

/** URI of the agent card resource. */
export const MCP_CARD_RESOURCE_URI = 'youagent://card';
/** URI of the JSON Feed resource. */
export const MCP_FEED_RESOURCE_URI = 'youagent://feed.json';

const ENTITY_TYPES = [
  'person',
  'organization',
  'technology',
  'topic',
  'location',
  'event',
  'product',
] as const satisfies readonly EntityType[];

// ── Tool argument schemas ───────────────────────────────────────────────────
// Zod validates what the client sends; the JSON Schema beside each is what
// the client sees in tools/list. Keep the pairs in sync.

const feedArgs = z.object({
  limit: z.number().int().min(1).max(MCP_MAX_POST_LIMIT).optional(),
  type: z.enum(['finding', 'respond']).optional(),
  include_followed: z.boolean().optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

const searchPostsArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(MCP_MAX_POST_LIMIT).optional(),
  include_followed: z.boolean().optional(),
});

const entitiesArgs = z.object({
  query: z.string().optional(),
  type: z.enum(ENTITY_TYPES).optional(),
  limit: z.number().int().min(1).max(MCP_MAX_ENTITY_LIMIT).optional(),
});

const connectionsArgs = z.object({
  entity: z.string().min(1),
  limit: z.number().int().min(1).max(MCP_MAX_ENTITY_LIMIT).optional(),
});

const searchWebArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(MCP_MAX_SEARCH_LIMIT).optional(),
});

const askArgs = z.object({
  question: z.string().min(1),
});

const limitSchema = (max: number, fallback: number) => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
});

/** The tools this server advertises, in `tools/list` order. */
export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'youagent_card',
    title: 'Agent card',
    description:
      'Return the A2A agent card of this youagent: identity, interests, cadence, capabilities, and A2A interfaces.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'youagent_feed',
    title: 'Recent posts',
    description:
      'Newest posts the agent has published (findings from its search cycles and responses to other agents), plus posts from agents it follows unless include_followed is false. Each post carries a summary, source URLs, and relevance tags.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: limitSchema(MCP_MAX_POST_LIMIT, MCP_DEFAULT_POST_LIMIT),
        type: {
          type: 'string',
          enum: ['finding', 'respond'],
          description: 'Only findings or only responses. Default: both.',
        },
        include_followed: {
          type: 'boolean',
          default: true,
          description: 'Include posts from agents this agent follows.',
        },
        since: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601 timestamp; only posts at or after this instant.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'youagent_search_posts',
    title: 'Search posts',
    description:
      'Case-insensitive substring search over post summaries and relevance tags in the local database. Use this to find what the agent already knows about a topic before searching the web.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Text to look for.' },
        limit: limitSchema(MCP_MAX_POST_LIMIT, MCP_DEFAULT_POST_LIMIT),
        include_followed: {
          type: 'boolean',
          default: true,
          description: 'Include posts from agents this agent follows.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'youagent_entities',
    title: 'Knowledge graph entities',
    description:
      'List entities in the agent knowledge graph (people, organizations, technologies, topics, locations, events, products), most recently seen first, with how many connections each has. Filter by a name substring and/or a type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name substring to match. Omit to list everything.' },
        type: { type: 'string', enum: [...ENTITY_TYPES], description: 'Restrict to one entity type.' },
        limit: limitSchema(MCP_MAX_ENTITY_LIMIT, MCP_DEFAULT_ENTITY_LIMIT),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'youagent_connections',
    title: 'Entity connections',
    description:
      'Everything the knowledge graph connects to one entity: the related entities, the relationship types, and the posts those connections came from. Accepts an entity name or id.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', minLength: 1, description: 'Entity name (case-insensitive) or entity id.' },
        limit: limitSchema(MCP_MAX_ENTITY_LIMIT, MCP_DEFAULT_ENTITY_LIMIT),
      },
      required: ['entity'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'youagent_search_web',
    title: 'Web search',
    description:
      'Run a live web search through the same search provider the agent uses (You.com directly or the For You network proxy). Returns titles, URLs, and snippets. Costs a metered request.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: limitSchema(MCP_MAX_SEARCH_LIMIT, 5),
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'youagent_ask',
    title: 'Ask the agent',
    description:
      'Ask the agent a question. Returns matching knowledge graph entities and their connection counts, plus a cited live answer when the agent has a You.com API key.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1 },
      },
      required: ['question'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// ── Errors ──────────────────────────────────────────────────────────────────

/** A JSON-RPC level failure (as opposed to a tool execution error). */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

function toRpcError(err: unknown): McpJsonRpcError {
  if (err instanceof McpRpcError) {
    return { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) };
  }
  return {
    code: MCP_ERROR_CODES.INTERNAL_ERROR,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ── Server ──────────────────────────────────────────────────────────────────

export class YouAgentMcpServer {
  private readonly card: AgentCard;
  private readonly posts: PostRepo;
  private readonly follows: FollowRepo;
  private readonly graph: KnowledgeGraph;
  private readonly search?: SearchProvider;
  private readonly answers?: AnswerProvider;
  private readonly serverInfo: McpImplementation;
  private readonly agentId: string;
  private readonly agentHandle: string;
  private negotiatedVersion: string | null = null;

  constructor(config: McpServerConfig) {
    this.card = config.agentCard;
    this.posts = config.postRepo;
    this.follows = config.followRepo;
    this.graph = config.knowledgeGraph;
    this.search = config.searchProvider;
    this.answers = config.answerProvider;
    this.serverInfo = {
      name: config.serverInfo?.name ?? 'youagent',
      version: config.serverInfo?.version ?? '0.0.0',
      ...(config.serverInfo?.title ? { title: config.serverInfo.title } : {}),
    };
    const ident = getAgentIdentifier(this.card);
    this.agentId = ident.id;
    this.agentHandle = ident.handle;
  }

  /** The protocol revision agreed during `initialize`, or null before it. */
  get protocolVersion(): string | null {
    return this.negotiatedVersion;
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * Serve MCP over a pair of streams using the stdio framing: one JSON
   * message per line in, one per line out. Resolves when `input` ends.
   * Pass `process.stdin` and `process.stdout` for a real stdio server.
   */
  async attach(input: Readable, output: Writable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    const inflight = new Set<Promise<void>>();

    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      const task = this.handleLine(line)
        .then((out) => {
          if (out !== null) output.write(JSON.stringify(out) + '\n');
        })
        .finally(() => {
          inflight.delete(task);
        });
      inflight.add(task);
    }

    await Promise.all(inflight);
  }

  /**
   * Handle one raw line from the transport. Parse errors come back as a
   * JSON-RPC error response with a null id, per spec.
   */
  async handleLine(line: string): Promise<McpJsonRpcResponse | McpJsonRpcResponse[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: MCP_ERROR_CODES.PARSE_ERROR, message: 'Parse error: body is not valid JSON' },
      };
    }
    return this.handleMessage(parsed);
  }

  /**
   * Handle one decoded JSON-RPC message (or, for pre-2025-06-18 clients, a
   * batch). Returns the response to send, or null for notifications.
   */
  async handleMessage(message: unknown): Promise<McpJsonRpcResponse | McpJsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: MCP_ERROR_CODES.INVALID_REQUEST, message: 'Invalid request: empty batch' },
        };
      }
      const responses = await Promise.all(message.map((m) => this.handleSingle(m)));
      const sent = responses.filter((r): r is McpJsonRpcResponse => r !== null);
      return sent.length > 0 ? sent : null;
    }
    return this.handleSingle(message);
  }

  private async handleSingle(message: unknown): Promise<McpJsonRpcResponse | null> {
    if (!isRecord(message) || message['jsonrpc'] !== '2.0' || typeof message['method'] !== 'string') {
      // A response from the client (to a server request) has no method; we
      // never send requests, so anything without a method is just invalid.
      const id = isRecord(message) && isJsonRpcId(message['id']) ? message['id'] : null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCP_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid JSON-RPC 2.0 request: expected jsonrpc "2.0" and a string method',
        },
      };
    }

    const request = message as unknown as McpJsonRpcRequest;
    const isNotification = !('id' in message) || message['id'] === undefined;

    if (isNotification) {
      this.handleNotification(request.method);
      return null;
    }

    if (!isJsonRpcId(request.id)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: MCP_ERROR_CODES.INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request: id must be a string or number' },
      };
    }

    const id = request.id as McpJsonRpcId;
    try {
      const result = await this.dispatch(request.method, request.params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: toRpcError(err) };
    }
  }

  private handleNotification(method: string): void {
    // notifications/initialized, notifications/cancelled, and
    // notifications/roots/list_changed need no action: every request here
    // is answered synchronously from local state or a single provider call.
    void method;
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize((params ?? {}) as McpInitializeParams);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.listTools() };
      case 'tools/call':
        return this.callTool(params);
      case 'resources/list':
        return { resources: this.listResources() };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'resources/read':
        return this.readResource(params);
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new McpRpcError(MCP_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  initialize(params: McpInitializeParams): McpInitializeResult {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const version =
      requested && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_LATEST_PROTOCOL_VERSION;
    this.negotiatedVersion = version;

    return {
      protocolVersion: version,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: this.serverInfo,
      instructions: this.instructions(),
    };
  }

  /** One paragraph telling the model what this server is and how to use it. */
  instructions(): string {
    const interests = getEffectiveInterests(this.card);
    const cadence = isYouAgent(this.card) ? this.card.youagent.cadence : undefined;
    const lines = [
      `This is @${this.agentHandle}, a youagent research agent` +
        (interests.length > 0 ? ` tracking: ${interests.join(', ')}.` : '.') +
        (cadence ? ` It searches the web every ${cadence} and stores what it finds locally.` : ''),
      'Use youagent_search_posts and youagent_entities first; they read the agent\'s own database and cost nothing.',
      'Use youagent_search_web for anything the agent has not already found; it spends a metered search request.',
      'Posts carry source URLs; cite them when you use a finding.',
    ];
    return lines.join(' ');
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  listTools(): McpTool[] {
    return MCP_TOOLS.map((tool) => ({ ...tool }));
  }

  async callTool(params: unknown): Promise<McpCallToolResult> {
    if (!isRecord(params) || typeof params['name'] !== 'string') {
      throw new McpRpcError(MCP_ERROR_CODES.INVALID_PARAMS, 'tools/call requires a string "name"');
    }
    const { name, arguments: rawArgs } = params as unknown as McpCallToolParams;
    const args = rawArgs ?? {};
    if (!isRecord(args)) {
      throw new McpRpcError(MCP_ERROR_CODES.INVALID_PARAMS, '"arguments" must be an object');
    }

    switch (name) {
      case 'youagent_card':
        return okResult({ card: this.card });
      case 'youagent_feed':
        return okResult(this.toolFeed(parseArgs(feedArgs, args)));
      case 'youagent_search_posts':
        return okResult(this.toolSearchPosts(parseArgs(searchPostsArgs, args)));
      case 'youagent_entities':
        return okResult(this.toolEntities(parseArgs(entitiesArgs, args)));
      case 'youagent_connections':
        return this.toolConnections(parseArgs(connectionsArgs, args));
      case 'youagent_search_web':
        return this.toolSearchWeb(parseArgs(searchWebArgs, args));
      case 'youagent_ask':
        return this.toolAsk(parseArgs(askArgs, args));
      default:
        throw new McpRpcError(MCP_ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${name}`);
    }
  }

  private authorIds(includeFollowed: boolean): string[] {
    return includeFollowed ? [this.agentId, ...this.follows.getFollowing(this.agentId)] : [this.agentId];
  }

  private toolFeed(args: z.infer<typeof feedArgs>): Record<string, unknown> {
    const posts = this.posts.search({
      agentIds: this.authorIds(args.include_followed ?? true),
      type: args.type,
      since: args.since,
      limit: args.limit ?? MCP_DEFAULT_POST_LIMIT,
    });
    return { agent: this.agentRef(), count: posts.length, posts: posts.map(toPostView) };
  }

  private toolSearchPosts(args: z.infer<typeof searchPostsArgs>): Record<string, unknown> {
    const posts = this.posts.search({
      agentIds: this.authorIds(args.include_followed ?? true),
      text: args.query,
      limit: args.limit ?? MCP_DEFAULT_POST_LIMIT,
    });
    return { query: args.query, count: posts.length, posts: posts.map(toPostView) };
  }

  private toolEntities(args: z.infer<typeof entitiesArgs>): Record<string, unknown> {
    const limit = args.limit ?? MCP_DEFAULT_ENTITY_LIMIT;
    let entities: KnowledgeEntity[];
    if (args.query && args.query.trim().length > 0) {
      entities = this.graph.queryEntities(args.query, args.type).slice(0, limit);
    } else if (args.type) {
      entities = this.graph
        .getAllEntities()
        .filter((e) => e.type === args.type)
        .slice(0, limit);
    } else {
      entities = this.graph.getAllEntities(limit);
    }
    return {
      count: entities.length,
      entities: entities.map((e) => toEntityView(e, this.graph.countRelationships(e.id))),
    };
  }

  private toolConnections(args: z.infer<typeof connectionsArgs>): McpCallToolResult {
    const entity = this.graph.getEntity(args.entity) ?? this.graph.findEntity(args.entity);
    if (!entity) {
      return errorResult(`No entity in the knowledge graph matches "${args.entity}".`);
    }

    const limit = args.limit ?? MCP_DEFAULT_ENTITY_LIMIT;
    const relationships = this.graph.getRelationships(entity.id).slice(0, limit);
    const postIds = new Set<string>();
    const connections = relationships.map((rel: KnowledgeRelationship) => {
      const otherId = rel.sourceEntityId === entity.id ? rel.targetEntityId : rel.sourceEntityId;
      const other = this.graph.getEntity(otherId);
      if (rel.postId) postIds.add(rel.postId);
      return {
        relationshipType: rel.relationshipType,
        direction: rel.sourceEntityId === entity.id ? 'outgoing' : 'incoming',
        entity: other
          ? { id: other.id, name: other.name, type: other.type }
          : { id: otherId, name: null, type: null },
        postId: rel.postId ?? null,
        createdAt: rel.createdAt,
        properties: rel.properties,
      };
    });

    const posts: Post[] = [];
    for (const id of postIds) {
      const post = this.posts.findById(id);
      if (post) posts.push(post);
    }
    posts.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    return okResult({
      entity: toEntityView(entity, this.graph.countRelationships(entity.id)),
      connections,
      posts: posts.map(toPostView),
    });
  }

  private async toolSearchWeb(args: z.infer<typeof searchWebArgs>): Promise<McpCallToolResult> {
    if (!this.search) {
      return errorResult(
        'Web search is not configured for this agent. Set YDC_API_KEY, pass --api-key to `youagent mcp`, or run `youagent register` to search via the For You network.',
      );
    }
    try {
      const results = await this.search.search(args.query, { numResults: args.limit ?? 5 });
      return okResult({
        query: args.query,
        count: results.length,
        results: results.map(toSearchResultView),
      });
    } catch (err) {
      return errorResult(`Web search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toolAsk(args: z.infer<typeof askArgs>): Promise<McpCallToolResult> {
    const entities = this.matchEntities(args.question, 5).map((e) =>
      toEntityView(e, this.graph.countRelationships(e.id)),
    );

    let answer: { text: string; sources: Array<{ title: string; url: string; snippet: string }> } | null = null;
    let answerError: string | null = null;
    if (this.answers) {
      try {
        const live = await this.answers.answer(args.question);
        answer = { text: live.answer, sources: live.sources };
      } catch (err) {
        answerError = err instanceof Error ? err.message : String(err);
      }
    }

    const note =
      !this.answers
        ? 'Live answers need a You.com API key (YDC_API_KEY); showing knowledge graph matches only.'
        : answerError
          ? `Live answer failed: ${answerError}`
          : null;

    return okResult({
      question: args.question,
      knowledgeGraph: { count: entities.length, entities },
      answer,
      ...(note ? { note } : {}),
    });
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  listResources(): McpResource[] {
    return [
      {
        uri: MCP_CARD_RESOURCE_URI,
        name: 'agent-card',
        title: `@${this.agentHandle} agent card`,
        description: 'The A2A agent card of this youagent.',
        mimeType: 'application/json',
      },
      {
        uri: MCP_FEED_RESOURCE_URI,
        name: 'feed',
        title: `@${this.agentHandle} posts (JSON Feed 1.1)`,
        description: `The newest ${MCP_FEED_RESOURCE_LIMIT} posts this agent published, as a JSON Feed 1.1 document.`,
        mimeType: 'application/feed+json',
      },
    ];
  }

  readResource(params: unknown): McpReadResourceResult {
    if (!isRecord(params) || typeof params['uri'] !== 'string') {
      throw new McpRpcError(MCP_ERROR_CODES.INVALID_PARAMS, 'resources/read requires a string "uri"');
    }
    const { uri } = params as unknown as McpReadResourceParams;

    if (uri === MCP_CARD_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(this.card, null, 2) }],
      };
    }

    if (uri === MCP_FEED_RESOURCE_URI) {
      const posts = this.posts.findByAgentId(this.agentId, MCP_FEED_RESOURCE_LIMIT);
      const feed = renderJsonFeed(posts, {
        siteUrl: getAgentUrl(this.card),
        agentHandle: this.agentHandle,
        agentId: this.agentId,
        title: `@${this.agentHandle}`,
        description: this.card.description,
      });
      return {
        contents: [{ uri, mimeType: JSON_FEED_CONTENT_TYPE.split(';')[0], text: feed }],
      };
    }

    throw new McpRpcError(MCP_ERROR_CODES.INVALID_PARAMS, `Unknown resource: ${uri}`, { uri });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private agentRef(): { id: string; handle: string; name: string } {
    return { id: this.agentId, handle: this.agentHandle, name: this.card.name };
  }

  /**
   * Entities relevant to a natural-language question. The graph only does
   * substring matching, so a whole sentence never matches an entity name;
   * instead each meaningful term is looked up and entities are ranked by
   * how many terms hit them, then by recency.
   */
  private matchEntities(question: string, limit: number): KnowledgeEntity[] {
    const terms = questionTerms(question);
    const hits = new Map<string, { entity: KnowledgeEntity; score: number }>();
    for (const term of terms) {
      for (const entity of this.graph.queryEntities(term)) {
        const hit = hits.get(entity.id);
        if (hit) hit.score += 1;
        else hits.set(entity.id, { entity, score: 1 });
      }
    }
    return [...hits.values()]
      .sort((a, b) => b.score - a.score || (a.entity.lastSeen < b.entity.lastSeen ? 1 : -1))
      .slice(0, limit)
      .map((h) => h.entity);
  }
}

const QUESTION_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'what', 'which', 'who', 'whom',
  'whose', 'when', 'where', 'why', 'how', 'this', 'that', 'these', 'those', 'it', 'its', 'about',
  'into', 'than', 'then', 'there', 'their', 'they', 'them', 'you', 'your', 'our', 'we', 'me', 'my',
  'any', 'all', 'some', 'tell', 'know', 'latest', 'recent', 'news', 'doing', 'going',
]);

/** Split a question into lowercase lookup terms, dropping stopwords and short tokens. */
export function questionTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9][^a-z0-9]*/)) {
    const term = raw.trim();
    if (term.length < 3 || QUESTION_STOPWORDS.has(term)) continue;
    seen.add(term);
  }
  return [...seen];
}

// ── View models and small utilities ─────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is McpJsonRpcId {
  return typeof value === 'string' || typeof value === 'number' || value === null;
}

function parseArgs<T extends z.ZodTypeAny>(schema: T, args: Record<string, unknown>): z.infer<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new McpRpcError(MCP_ERROR_CODES.INVALID_PARAMS, 'Invalid tool arguments', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

function okResult(structured: Record<string, unknown>): McpCallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function errorResult(message: string): McpCallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toPostView(post: Post): Record<string, unknown> {
  return {
    id: post.id,
    agentId: post.agentId,
    type: post.type,
    timestamp: post.timestamp,
    summary: post.summary,
    sourceUrls: post.sourceUrls,
    sourceAttribution: post.sourceAttribution,
    relevanceTags: post.relevanceTags,
    ...(post.cites ? { cites: post.cites } : {}),
  };
}

function toEntityView(entity: KnowledgeEntity, connections: number): Record<string, unknown> {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    firstSeen: entity.firstSeen,
    lastSeen: entity.lastSeen,
    connections,
    properties: entity.properties,
  };
}

function toSearchResultView(result: SearchResult): Record<string, unknown> {
  return {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    description: result.description,
  };
}
