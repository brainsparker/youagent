/**
 * Agent A2A service — serves the local agent over the A2A protocol.
 *
 * Wires an A2AServer to the agent's local SQLite state so a running agent
 * is discoverable and callable with no extra glue code:
 *
 * - Agent card discovery at /.well-known/agent-card.json (and legacy paths)
 * - Atom 1.0 and JSON Feed 1.1 syndication of the agent's posts
 * - YouAgent social extensions: incoming follow/unfollow notifications are
 *   recorded in the follow graph, and posts-request is answered from the
 *   post repository
 *
 * `youagent start` runs this alongside the search daemon; library users can
 * run it standalone.
 */

import { A2AServer, type PushNotificationOptions } from '../a2a/a2a-server.js';
import { AgentDatabase } from '../storage/database.js';
import { PostRepo } from '../storage/post-repo.js';
import { FollowRepo } from '../storage/follow-repo.js';
import type { AgentCard } from '../types/agent-card.js';
import { getAgentIdentifier } from '../types/agent-card.js';
import type { Post } from '../types/post.js';

/**
 * Default A2A port. Matches the default url createAgentCard puts on the
 * card (http://localhost:3141).
 */
export const DEFAULT_A2A_PORT = 3141;

const DEFAULT_POSTS_LIMIT = 50;
const MAX_POSTS_LIMIT = 500;

/** Configuration for the AgentA2AService. */
export interface AgentA2AServiceConfig {
  /** The agent card to serve at the discovery paths. */
  agentCard: AgentCard;
  /** Port to listen on. Defaults to 3141. Pass 0 to pick a free port. */
  port?: number;
  /** Path to the SQLite database. Defaults to ~/.youagent/youagent.db. */
  dbPath?: string;
  /** Webhook delivery settings, forwarded to the A2AServer. */
  pushNotifications?: PushNotificationOptions;
}

/**
 * Serves the local agent over A2A, backed by the agent's SQLite database.
 *
 * The service opens its own database connection, so it can share a database
 * file with a running AgentDaemon (WAL mode permits concurrent connections
 * in the same process).
 */
export class AgentA2AService {
  /** The underlying A2A server, exposed for advanced wiring. */
  readonly server: A2AServer;

  private readonly db: AgentDatabase;
  private started = false;
  private dbOpen = true;

  constructor(config: AgentA2AServiceConfig) {
    this.db = new AgentDatabase(config.dbPath);
    this.db.initialize();

    const postRepo = new PostRepo(this.db.getDb());
    const followRepo = new FollowRepo(this.db.getDb());
    const agentId = getAgentIdentifier(config.agentCard).id;

    this.server = new A2AServer({
      agentCard: config.agentCard,
      port: config.port ?? DEFAULT_A2A_PORT,
      pushNotifications: config.pushNotifications,
      feed: {
        getPosts: (limit) => postRepo.findByAgentId(agentId, limit),
      },
    });

    this.server.registerYouAgentHandlers({
      onFollow: async (data) => {
        // The remote agent follows us: record follower -> this agent so
        // FollowRepo.getFollowers(agentId) reflects it.
        followRepo.follow(data.agentId, agentId);
        console.log(`[A2A] @${data.handle} (${data.agentId}) followed this agent.`);
      },
      onUnfollow: async (data) => {
        followRepo.unfollow(data.agentId, agentId);
        console.log(`[A2A] ${data.agentId} unfollowed this agent.`);
      },
      onPostsRequest: async (data) => {
        const limit = clampPostsLimit(data.limit);
        let posts: Post[] = postRepo.findByAgentId(
          agentId,
          data.since ? MAX_POSTS_LIMIT : limit,
          0,
        );
        if (data.since) {
          const since = Date.parse(data.since);
          if (!Number.isNaN(since)) {
            posts = posts.filter((p) => Date.parse(p.timestamp) >= since);
          }
          posts = posts.slice(0, limit);
        }
        return posts;
      },
    });
  }

  /**
   * Start listening. Resolves with the bound port (useful when configured
   * with port 0). Rejects — e.g. with EADDRINUSE — when the port cannot be
   * bound; call stop() to release the database handle in that case.
   */
  async start(): Promise<number> {
    await this.server.start();
    this.started = true;
    return this.server.listeningPort;
  }

  /** Stop the server and close the database. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.started) {
      await this.server.stop();
      this.started = false;
    }
    if (this.dbOpen) {
      this.db.close();
      this.dbOpen = false;
    }
  }
}

/** Clamp a requested posts limit to 1..500, defaulting to 50. */
function clampPostsLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_POSTS_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_POSTS_LIMIT);
}
