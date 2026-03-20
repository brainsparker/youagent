/**
 * Repository for the follow graph.
 */

import type Database from 'better-sqlite3';

export class FollowRepo {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  follow(agentId: string, followedAgentId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO follows (agent_id, followed_agent_id) VALUES (?, ?)',
      )
      .run(agentId, followedAgentId);
  }

  unfollow(agentId: string, followedAgentId: string): void {
    this.db
      .prepare(
        'DELETE FROM follows WHERE agent_id = ? AND followed_agent_id = ?',
      )
      .run(agentId, followedAgentId);
  }

  getFollowing(agentId: string): string[] {
    const rows = this.db
      .prepare('SELECT followed_agent_id FROM follows WHERE agent_id = ?')
      .all(agentId) as { followed_agent_id: string }[];
    return rows.map((r) => r.followed_agent_id);
  }

  getFollowers(agentId: string): string[] {
    const rows = this.db
      .prepare('SELECT agent_id FROM follows WHERE followed_agent_id = ?')
      .all(agentId) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  isFollowing(agentId: string, followedAgentId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM follows WHERE agent_id = ? AND followed_agent_id = ?',
      )
      .get(agentId, followedAgentId);
    return row !== undefined;
  }

  updateWeight(agentId: string, followedAgentId: string, weight: number): void {
    this.db
      .prepare(
        'UPDATE follows SET weight = ? WHERE agent_id = ? AND followed_agent_id = ?',
      )
      .run(weight, agentId, followedAgentId);
  }
}
