/**
 * SQLite database initialization and migration for YouAgent.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_PATH = join(homedir(), '.youagent', 'youagent.db');

/**
 * Detect failures caused by a missing or incompatible better-sqlite3
 * native binding, as opposed to ordinary database errors.
 */
function isNativeModuleError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') return true;
  return /better_sqlite3\.node|Could not locate the bindings file|NODE_MODULE_VERSION/i.test(
    err.message
  );
}

export class AgentDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(dirname(resolvedPath), { recursive: true });
    try {
      this.db = new Database(resolvedPath);
    } catch (err) {
      if (isNativeModuleError(err)) {
        throw new Error(
          'youagent could not load its SQLite engine (better-sqlite3). ' +
            'The native module is missing or was built for a different Node.js version.\n' +
            'To fix, run: npm rebuild better-sqlite3\n' +
            'Or reinstall youagent on Node.js 20 or newer so a prebuilt binary can be used.\n' +
            `Original error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      throw err;
    }

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
        interests TEXT,
        knowledge_domains TEXT,
        cadence TEXT,
        card_type TEXT NOT NULL DEFAULT 'youagent',
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

    // Migration: add card_type column for existing databases
    const cols = this.db.prepare("PRAGMA table_info(agent_cards)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('card_type')) {
      this.db.exec("ALTER TABLE agent_cards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'youagent'");
    }
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
