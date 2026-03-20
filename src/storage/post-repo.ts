/**
 * Repository for Post persistence.
 */

import type Database from 'better-sqlite3';
import type { Post } from '../types/post.js';

interface PostRow {
  id: string;
  agent_id: string;
  summary: string;
  source_urls: string;
  source_attribution: string;
  timestamp: string;
  relevance_tags: string;
  cites: string | null;
  type: string;
  created_at: string;
}

function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    agentId: row.agent_id,
    summary: row.summary,
    sourceUrls: JSON.parse(row.source_urls),
    sourceAttribution: row.source_attribution,
    timestamp: row.timestamp,
    relevanceTags: JSON.parse(row.relevance_tags),
    cites: row.cites ?? undefined,
    type: row.type as Post['type'],
  };
}

export class PostRepo {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  save(post: Post): void {
    const stmt = this.db.prepare(`
      INSERT INTO posts (id, agent_id, summary, source_urls, source_attribution, timestamp, relevance_tags, cites, type)
      VALUES (@id, @agentId, @summary, @sourceUrls, @sourceAttribution, @timestamp, @relevanceTags, @cites, @type)
    `);

    stmt.run({
      id: post.id,
      agentId: post.agentId,
      summary: post.summary,
      sourceUrls: JSON.stringify(post.sourceUrls),
      sourceAttribution: post.sourceAttribution,
      timestamp: post.timestamp,
      relevanceTags: JSON.stringify(post.relevanceTags),
      cites: post.cites ?? null,
      type: post.type,
    });
  }

  findById(id: string): Post | null {
    const row = this.db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
    return row ? rowToPost(row) : null;
  }

  findByAgentId(agentId: string, limit = 50, offset = 0): Post[] {
    const rows = this.db
      .prepare('SELECT * FROM posts WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?')
      .all(agentId, limit, offset) as PostRow[];
    return rows.map(rowToPost);
  }

  findByAgentIds(agentIds: string[], limit = 50, offset = 0): Post[] {
    if (agentIds.length === 0) return [];

    const placeholders = agentIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM posts WHERE agent_id IN (${placeholders}) ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...agentIds, limit, offset) as PostRow[];
    return rows.map(rowToPost);
  }

  /**
   * Find all "respond" posts that cite the given post ID.
   */
  findCitations(postId: string): Post[] {
    const rows = this.db
      .prepare('SELECT * FROM posts WHERE cites = ? ORDER BY timestamp DESC')
      .all(postId) as PostRow[];
    return rows.map(rowToPost);
  }

  countByAgentId(agentId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM posts WHERE agent_id = ?')
      .get(agentId) as { count: number };
    return row.count;
  }
}
