/**
 * Agent Daemon — scheduled search cycle runner.
 *
 * The daemon loads an agent card, schedules periodic search cycles via
 * node-cron, and persists discovered findings as posts in the local
 * SQLite database. With a `serve` config it also serves the agent over A2A
 * from the same process and database, so a running agent is discoverable at
 * /.well-known/agent-card.json, answers JSON-RPC, syndicates its posts, and
 * keeps its tasks across restarts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';

import { AgentDatabase } from '../storage/database.js';
import { PostRepo } from '../storage/post-repo.js';
import { FollowRepo } from '../storage/follow-repo.js';
import { SqliteTaskStore } from '../storage/sqlite-task-store.js';
import { QueryMapper } from '../engine/query-mapper.js';
import { FindingExtractorImpl } from '../engine/finding-extractor.js';
import type { Finding } from '../engine/finding-extractor.js';
import { YouSearchClient } from '../client/you-client.js';
import type { SearchProvider } from '../client/types.js';
import type { NetworkPusher } from '../registry/pusher.js';
import type { AgentCard } from '../types/agent-card.js';
import {
  A2A_BINDING_JSONRPC,
  A2A_WELL_KNOWN_PATH,
  isYouAgent,
  getAgentIdentifier,
  getAgentUrl,
  getEffectiveInterests,
} from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { A2AServer, ATOM_FEED_PATH, JSON_FEED_PATH } from '../a2a/a2a-server.js';
import type { PushNotificationOptions } from '../a2a/a2a-server.js';
import { shorthandToCron } from './cadence.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration options for the AgentDaemon. */
export interface DaemonConfig {
  /** You.com API key. Either this or `searchClient` is required. */
  apiKey?: string;
  /**
   * Search provider to use instead of a direct You.com key — e.g. a
   * `NetworkSearchClient` backed by the For You network's metered proxy.
   * Takes precedence over `apiKey`.
   */
  searchClient?: SearchProvider;
  /**
   * When set, new posts from each search cycle are pushed to the network
   * (best-effort; push failures never fail the cycle).
   */
  pusher?: NetworkPusher;
  /** Path to the agent-card.json file. Defaults to ~/.youagent/agent-card.json. */
  agentCardPath?: string;
  /** Path to the SQLite database. Defaults to ~/.youagent/youagent.db. */
  dbPath?: string;
  /**
   * Serve the agent over A2A while the daemon runs. Omit to run search
   * cycles only (the pre-0.3 behavior).
   */
  serve?: DaemonServeConfig;
}

/**
 * How the daemon serves the agent over A2A. Everything is optional: an empty
 * object serves the card as-is on the port its URL names (or 3141).
 */
export interface DaemonServeConfig {
  /**
   * Port to listen on. Defaults to the port in the card's A2A URL, or 3141
   * when the URL has none. Pass 0 to let the OS pick (tests).
   */
  port?: number;
  /**
   * Public base URL peers should use to reach this agent, for example
   * `https://agents.example.com/climate-watch` behind a reverse proxy. When
   * set, the served card advertises this URL as its JSON-RPC interface and
   * the feeds use it for their self links. Defaults to the card's own URL.
   */
  publicUrl?: string;
  /** Title for the Atom and JSON feeds. Defaults to `@handle`. */
  feedTitle?: string;
  /** Webhook delivery settings; see {@link PushNotificationOptions}. */
  pushNotifications?: PushNotificationOptions;
  /** Cache-Control max-age for the served card, in seconds. Defaults to 3600. */
  cardMaxAgeSeconds?: number;
}

/** What the daemon is serving, as reported by {@link AgentDaemon.serving}. */
export interface DaemonServeInfo {
  /** Bound port. */
  port: number;
  /** Base URL the card advertises (`publicUrl` or the card's own URL). */
  url: string;
  /** Full URL of the A2A v1.0 card discovery path. */
  cardUrl: string;
  /** Full URL of the Atom feed. */
  atomFeedUrl: string;
  /** Full URL of the JSON Feed. */
  jsonFeedUrl: string;
}

const DEFAULT_AGENT_CARD_PATH = join(homedir(), '.youagent', 'agent-card.json');
const DEFAULT_A2A_PORT = 3141;
/** Upper bound on posts returned for a single youagent/posts-request. */
const MAX_POSTS_REQUEST_LIMIT = 500;
const DEFAULT_POSTS_REQUEST_LIMIT = 50;

/**
 * Return a copy of the card whose JSON-RPC interface (and legacy `url`) point
 * at `url`, for serving behind a proxy or on a public host.
 */
export function withAgentUrl(card: AgentCard, url: string): AgentCard {
  const normalized = url.replace(/\/+$/, '');
  let replaced = false;
  const supportedInterfaces = card.supportedInterfaces.map((iface) => {
    if (!replaced && iface.protocolBinding === A2A_BINDING_JSONRPC) {
      replaced = true;
      return { ...iface, url: normalized };
    }
    return iface;
  });
  return { ...card, url: normalized, supportedInterfaces };
}

/** The card's A2A URL with its port replaced, so peers dial the bound port. */
function withPort(url: string, port: number): string {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return `http://localhost:${port}`;
  }
}

/** Port named by the card's A2A URL, or the default when it has none. */
function portFromCard(card: AgentCard): number {
  try {
    const parsed = new URL(getAgentUrl(card));
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : DEFAULT_A2A_PORT;
  } catch {
    return DEFAULT_A2A_PORT;
  }
}

// ---------------------------------------------------------------------------
// AgentDaemon
// ---------------------------------------------------------------------------

export class AgentDaemon {
  private db: AgentDatabase;
  private searchClient: SearchProvider;
  private queryMapper: QueryMapper;
  private extractor: FindingExtractorImpl;
  private pusher?: NetworkPusher;
  private postRepo!: PostRepo;
  private cronJob: ReturnType<typeof cron.schedule> | null = null;
  private running: boolean = false;
  private readonly serveConfig?: DaemonServeConfig;
  private server: A2AServer | null = null;
  private serveInfo: DaemonServeInfo | null = null;

  private readonly agentCardPath: string;
  /** Whether the daemon created the search client (and should dispose it). */
  private readonly ownsSearchClient: boolean;

  constructor(config: DaemonConfig) {
    this.agentCardPath = config.agentCardPath ?? DEFAULT_AGENT_CARD_PATH;
    this.db = new AgentDatabase(config.dbPath);

    if (config.searchClient) {
      this.searchClient = config.searchClient;
      this.ownsSearchClient = false;
    } else if (config.apiKey) {
      this.searchClient = new YouSearchClient({ apiKey: config.apiKey });
      this.ownsSearchClient = true;
    } else {
      throw new Error('AgentDaemon requires an apiKey or a searchClient.');
    }

    this.pusher = config.pusher;
    this.serveConfig = config.serve;
    this.queryMapper = new QueryMapper();
    // The extractor's RAG summarisation needs a full You.com client; with a
    // proxy-backed provider it falls back to snippet truncation.
    this.extractor = new FindingExtractorImpl(
      this.searchClient instanceof YouSearchClient ? this.searchClient : undefined,
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the daemon.
   *
   * Initializes the database, loads the agent card, schedules the search
   * cycle according to the card's cadence, and runs an initial cycle
   * immediately.
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('[AgentDaemon] Already running.');
      return;
    }

    // Initialize storage.
    this.db.initialize();
    this.postRepo = new PostRepo(this.db.getDb());

    // Load agent card to determine cadence.
    const card = await this.loadAgentCard();
    if (!isYouAgent(card)) {
      throw new Error('AgentDaemon requires a YouAgent card with cadence and interests');
    }
    const cronExpression = shorthandToCron(card.youagent.cadence);
    const ident = getAgentIdentifier(card);

    console.log(`[AgentDaemon] Starting daemon for agent "${ident.handle}" (${ident.id})`);
    console.log(`[AgentDaemon] Cadence: ${card.youagent.cadence} -> cron: ${cronExpression}`);
    console.log(`[AgentDaemon] Interests: ${getEffectiveInterests(card).join(', ')}`);

    // Serve the agent over A2A before the first search cycle so peers can
    // reach it as soon as the process is up. A port clash surfaces here,
    // before any search spend.
    if (this.serveConfig) {
      try {
        await this.startServer(card, this.serveConfig);
      } catch (err) {
        this.db.close();
        throw err;
      }
    }

    // Schedule recurring search cycles.
    this.cronJob = cron.schedule(cronExpression, async () => {
      try {
        console.log(`[AgentDaemon] Scheduled search cycle starting at ${new Date().toISOString()}`);
        const posts = await this.runSearchCycle();
        console.log(`[AgentDaemon] Search cycle complete — ${posts.length} new post(s).`);
      } catch (err) {
        console.error('[AgentDaemon] Search cycle failed:', err);
      }
    });

    this.running = true;
    console.log('[AgentDaemon] Daemon started. Running initial search cycle...');

    // Run an initial search cycle immediately.
    try {
      const posts = await this.runSearchCycle();
      console.log(`[AgentDaemon] Initial search cycle complete — ${posts.length} new post(s).`);
    } catch (err) {
      console.error('[AgentDaemon] Initial search cycle failed:', err);
    }
  }

  /**
   * Stop the daemon.
   *
   * Cancels the scheduled cron job, disposes the search client, and closes
   * the database connection.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      console.warn('[AgentDaemon] Not running.');
      return;
    }

    console.log('[AgentDaemon] Stopping daemon...');

    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.serveInfo = null;
    }

    // Injected clients belong to the caller — only dispose our own.
    if (this.ownsSearchClient) {
      this.searchClient.dispose();
    }
    this.db.close();
    this.running = false;

    console.log('[AgentDaemon] Daemon stopped.');
  }

  // -----------------------------------------------------------------------
  // Search cycle
  // -----------------------------------------------------------------------

  /**
   * Run a single search cycle.
   *
   * 1. Load the agent card from disk.
   * 2. Generate search queries from the agent's interests.
   * 3. Execute each query against the You.com Search API.
   * 4. Extract findings from the raw results.
   * 5. Deduplicate against the last 100 posts in the database.
   * 6. Convert unique findings to Post objects and persist them.
   * 7. Push new posts to the network when a pusher is configured.
   *
   * @returns The newly created posts.
   */
  async runSearchCycle(): Promise<Post[]> {
    // 1. Load agent card.
    const card = await this.loadAgentCard();

    // 2. Generate queries from interests.
    if (!isYouAgent(card)) {
      throw new Error('AgentDaemon requires a YouAgent card with interests');
    }
    const queries = this.queryMapper.generateQueries(card.youagent.interests);
    console.log(`[AgentDaemon] Generated ${queries.length} search queries.`);

    // 3. Execute searches and collect raw results.
    const allFindings: Finding[] = [];

    for (const sq of queries) {
      try {
        const results = await this.searchClient.search(sq.query);
        const findings = await this.extractor.extract(results, sq.interest);
        allFindings.push(...findings);
      } catch (err) {
        console.error(`[AgentDaemon] Search failed for query "${sq.query}":`, err);
        // Continue with remaining queries.
      }
    }

    console.log(`[AgentDaemon] Extracted ${allFindings.length} total findings.`);

    // 4. Load existing posts for deduplication.
    const agentId = getAgentIdentifier(card).id;
    const existingPosts = this.postRepo.findByAgentId(agentId, 100, 0);
    const existingFindings: Finding[] = existingPosts.map((post) => ({
      title: post.summary,
      summary: post.summary,
      sourceUrl: post.sourceUrls[0] ?? '',
      sourceAttribution: post.sourceAttribution,
      relevanceTags: post.relevanceTags,
      interest: '',
    }));

    // 5. Deduplicate.
    const uniqueFindings = this.extractor.deduplicate(allFindings, existingFindings);
    console.log(`[AgentDaemon] ${uniqueFindings.length} unique findings after deduplication.`);

    // 6. Convert to Post objects and save.
    const now = new Date().toISOString();
    const newPosts: Post[] = uniqueFindings.map((finding) => ({
      id: uuidv4(),
      agentId,
      summary: finding.summary,
      sourceUrls: [finding.sourceUrl],
      sourceAttribution: finding.sourceAttribution,
      timestamp: now,
      relevanceTags: finding.relevanceTags,
      type: 'finding' as const,
    }));

    for (const post of newPosts) {
      this.postRepo.save(post);
    }

    // 7. Best-effort push to the network; failures never fail the cycle.
    if (this.pusher && newPosts.length > 0) {
      try {
        const result = await this.pusher.push(newPosts);
        console.log(
          `[AgentDaemon] Pushed to network — ${result.accepted}/${result.received} accepted.`,
        );
      } catch (err) {
        console.error('[AgentDaemon] Network push failed:', err);
      }
    }

    return newPosts;
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Check whether the daemon is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** The A2A server this daemon is serving, or null when not serving. */
  get a2aServer(): A2AServer | null {
    return this.server;
  }

  /** Where the agent is being served, or null when not serving. */
  get serving(): DaemonServeInfo | null {
    return this.serveInfo;
  }

  // -----------------------------------------------------------------------
  // A2A serving
  // -----------------------------------------------------------------------

  /**
   * Start an A2AServer wired to this daemon's database: the card at the
   * well-known path, posts as Atom and JSON feeds, follow and unfollow
   * requests recorded in the follow graph, posts-request answered from the
   * post repo, and tasks plus push notification configs in SQLite.
   */
  private async startServer(card: AgentCard, serve: DaemonServeConfig): Promise<void> {
    const ident = getAgentIdentifier(card);
    const db = this.db.getDb();
    const followRepo = new FollowRepo(db);
    const postRepo = this.postRepo;
    const cardPort = portFromCard(card);
    const port = serve.port ?? cardPort;
    // Advertise what peers can actually dial: the public URL when given,
    // otherwise the card's URL, re-pointed at the port we are asked to bind
    // when that differs from the one the card names. (Port 0 is resolved by
    // the OS after listen, so the card keeps its own URL in that case.)
    let servedCard = card;
    if (serve.publicUrl) {
      servedCard = withAgentUrl(card, serve.publicUrl);
    } else if (port !== 0 && port !== cardPort) {
      servedCard = withAgentUrl(card, withPort(getAgentUrl(card), port));
    }

    const server = new A2AServer({
      agentCard: servedCard,
      port,
      taskStore: new SqliteTaskStore(db),
      cardMaxAgeSeconds: serve.cardMaxAgeSeconds,
      pushNotifications: serve.pushNotifications,
      feed: {
        getPosts: (limit) => postRepo.findByAgentId(ident.id, limit),
        title: serve.feedTitle,
        publicUrl: serve.publicUrl,
      },
    });

    server.registerYouAgentHandlers({
      onFollow: async (data) => {
        // A peer telling us it follows this agent: record it as a follower.
        followRepo.follow(data.agentId, ident.id);
        console.log(`[AgentDaemon] New follower: @${data.handle} (${data.agentId})`);
      },
      onUnfollow: async (data) => {
        followRepo.unfollow(data.agentId, ident.id);
        console.log(`[AgentDaemon] Follower left: ${data.agentId}`);
      },
      onPostsRequest: async (data) => {
        const limit = Math.min(
          Math.max(1, Math.floor(data.limit ?? DEFAULT_POSTS_REQUEST_LIMIT)),
          MAX_POSTS_REQUEST_LIMIT,
        );
        const posts = postRepo.findByAgentId(ident.id, limit);
        return data.since ? posts.filter((p) => p.timestamp > (data.since as string)) : posts;
      },
    });

    await server.start();
    this.server = server;

    const boundPort = server.listeningPort;
    const base = (serve.publicUrl ?? withPort(getAgentUrl(card), boundPort)).replace(/\/+$/, '');
    this.serveInfo = {
      port: boundPort,
      url: base,
      cardUrl: `${base}${A2A_WELL_KNOWN_PATH}`,
      atomFeedUrl: `${base}${ATOM_FEED_PATH}`,
      jsonFeedUrl: `${base}${JSON_FEED_PATH}`,
    };
    console.log(`[AgentDaemon] Serving A2A on port ${boundPort}: ${this.serveInfo.cardUrl}`);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Load the agent card from the JSON file on disk.
   */
  private async loadAgentCard(): Promise<AgentCard> {
    const raw = await readFile(this.agentCardPath, 'utf-8');
    return JSON.parse(raw) as AgentCard;
  }
}
