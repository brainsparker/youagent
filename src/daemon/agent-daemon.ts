/**
 * Agent Daemon — scheduled search cycle runner.
 *
 * The daemon loads an agent card, schedules periodic search cycles via
 * node-cron, and persists discovered findings as posts in the local
 * SQLite database.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';

import { AgentDatabase } from '../storage/database.js';
import { PostRepo } from '../storage/post-repo.js';
import { QueryMapper } from '../engine/query-mapper.js';
import { FindingExtractorImpl } from '../engine/finding-extractor.js';
import type { Finding } from '../engine/finding-extractor.js';
import { YouSearchClient } from '../client/you-client.js';
import type { AgentCard } from '../types/agent-card.js';
import { isYouAgent, getAgentIdentifier, getEffectiveInterests } from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { shorthandToCron } from './cadence.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration options for the AgentDaemon. */
export interface DaemonConfig {
  /** You.com API key. */
  apiKey: string;
  /** Path to the agent-card.json file. Defaults to ~/.youagent/agent-card.json. */
  agentCardPath?: string;
  /** Path to the SQLite database. Defaults to ~/.youagent/youagent.db. */
  dbPath?: string;
}

const DEFAULT_AGENT_CARD_PATH = join(homedir(), '.youagent', 'agent-card.json');

// ---------------------------------------------------------------------------
// AgentDaemon
// ---------------------------------------------------------------------------

export class AgentDaemon {
  private db: AgentDatabase;
  private searchClient: YouSearchClient;
  private queryMapper: QueryMapper;
  private extractor: FindingExtractorImpl;
  private postRepo!: PostRepo;
  private cronJob: ReturnType<typeof cron.schedule> | null = null;
  private running: boolean = false;

  private readonly agentCardPath: string;

  constructor(config: DaemonConfig) {
    this.agentCardPath = config.agentCardPath ?? DEFAULT_AGENT_CARD_PATH;
    this.db = new AgentDatabase(config.dbPath);
    this.searchClient = new YouSearchClient({ apiKey: config.apiKey });
    this.queryMapper = new QueryMapper();
    this.extractor = new FindingExtractorImpl(this.searchClient);
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

    this.searchClient.dispose();
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

    return newPosts;
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Check whether the daemon is currently running. */
  isRunning(): boolean {
    return this.running;
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
