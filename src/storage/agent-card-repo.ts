/**
 * Repository for AgentCard persistence.
 */

import type Database from 'better-sqlite3';
import type { AgentCard } from '../types/agent-card.js';

interface AgentCardRow {
  id: string;
  handle: string;
  display_name: string;
  description: string | null;
  interests: string;
  knowledge_domains: string | null;
  cadence: string;
  human_in_the_loop: string | null;
  capabilities: string | null;
  network: string | null;
  endpoints: string | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAgentCard(row: AgentCardRow): AgentCard {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    description: row.description ?? undefined,
    interests: JSON.parse(row.interests),
    knowledgeDomains: row.knowledge_domains ? JSON.parse(row.knowledge_domains) : undefined,
    cadence: row.cadence,
    humanInTheLoop: row.human_in_the_loop ? JSON.parse(row.human_in_the_loop) : undefined,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
    network: row.network ? JSON.parse(row.network) : undefined,
    endpoints: row.endpoints ? JSON.parse(row.endpoints) : undefined,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
  };
}

export class AgentCardRepo {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  save(card: AgentCard): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_cards (id, handle, display_name, description, interests, knowledge_domains, cadence, human_in_the_loop, capabilities, network, endpoints, meta)
      VALUES (@id, @handle, @displayName, @description, @interests, @knowledgeDomains, @cadence, @humanInTheLoop, @capabilities, @network, @endpoints, @meta)
    `);

    stmt.run({
      id: card.id,
      handle: card.handle,
      displayName: card.displayName,
      description: card.description ?? null,
      interests: JSON.stringify(card.interests),
      knowledgeDomains: card.knowledgeDomains ? JSON.stringify(card.knowledgeDomains) : null,
      cadence: card.cadence,
      humanInTheLoop: card.humanInTheLoop ? JSON.stringify(card.humanInTheLoop) : null,
      capabilities: card.capabilities ? JSON.stringify(card.capabilities) : null,
      network: card.network ? JSON.stringify(card.network) : null,
      endpoints: card.endpoints ? JSON.stringify(card.endpoints) : null,
      meta: card.meta ? JSON.stringify(card.meta) : null,
    });
  }

  findById(id: string): AgentCard | null {
    const row = this.db.prepare('SELECT * FROM agent_cards WHERE id = ?').get(id) as AgentCardRow | undefined;
    return row ? rowToAgentCard(row) : null;
  }

  findByHandle(handle: string): AgentCard | null {
    const row = this.db.prepare('SELECT * FROM agent_cards WHERE handle = ?').get(handle) as AgentCardRow | undefined;
    return row ? rowToAgentCard(row) : null;
  }

  update(card: AgentCard): void {
    const stmt = this.db.prepare(`
      UPDATE agent_cards
      SET handle = @handle,
          display_name = @displayName,
          description = @description,
          interests = @interests,
          knowledge_domains = @knowledgeDomains,
          cadence = @cadence,
          human_in_the_loop = @humanInTheLoop,
          capabilities = @capabilities,
          network = @network,
          endpoints = @endpoints,
          meta = @meta,
          updated_at = datetime('now')
      WHERE id = @id
    `);

    stmt.run({
      id: card.id,
      handle: card.handle,
      displayName: card.displayName,
      description: card.description ?? null,
      interests: JSON.stringify(card.interests),
      knowledgeDomains: card.knowledgeDomains ? JSON.stringify(card.knowledgeDomains) : null,
      cadence: card.cadence,
      humanInTheLoop: card.humanInTheLoop ? JSON.stringify(card.humanInTheLoop) : null,
      capabilities: card.capabilities ? JSON.stringify(card.capabilities) : null,
      network: card.network ? JSON.stringify(card.network) : null,
      endpoints: card.endpoints ? JSON.stringify(card.endpoints) : null,
      meta: card.meta ? JSON.stringify(card.meta) : null,
    });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agent_cards WHERE id = ?').run(id);
  }
}
