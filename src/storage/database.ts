/**
 * SQLite database initialization and migration for YouAgent.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_PATH = join(homedir(), '.youagent', 'youagent.db');

export class AgentDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);

    // Enable WAL mode for better concurrent read performance.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Run all migrations to bring the schema up to date.
   */
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_cards (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        interests TEXT NOT NULL,
        knowledge_domains TEXT,
        cadence TEXT NOT NULL,
        human_in_the_loop TEXT,
        capabilities TEXT,
        network TEXT,
        endpoints TEXT,
        meta TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_urls TEXT NOT NULL,
        source_attribution TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        relevance_tags TEXT NOT NULL,
        cites TEXT,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_posts_agent_id ON posts (agent_id);
      CREATE INDEX IF NOT EXISTS idx_posts_cites ON posts (cites);
      CREATE INDEX IF NOT EXISTS idx_posts_timestamp ON posts (timestamp DESC);

      CREATE TABLE IF NOT EXISTS follows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        followed_agent_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(agent_id, followed_agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_follows_agent_id ON follows (agent_id);
      CREATE INDEX IF NOT EXISTS idx_follows_followed_agent_id ON follows (followed_agent_id);

      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS knowledge_relationships (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL REFERENCES knowledge_entities(id),
        target_entity_id TEXT NOT NULL REFERENCES knowledge_entities(id),
        relationship_type TEXT NOT NULL,
        properties TEXT,
        post_id TEXT REFERENCES posts(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_kr_source ON knowledge_relationships (source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kr_target ON knowledge_relationships (target_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kr_post ON knowledge_relationships (post_id);

      CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        query TEXT NOT NULL,
        results_count INTEGER NOT NULL DEFAULT 0,
        executed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_search_history_agent_id ON search_history (agent_id);
    `);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get the underlying better-sqlite3 Database instance.
   */
  getDb(): Database.Database {
    return this.db;
  }
}
