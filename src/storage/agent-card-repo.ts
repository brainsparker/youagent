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
    // A2A base fields
    name: row.display_name,
    description: row.description ?? '',
    url: 'http://localhost:3141',
    version: '0.1.0',
    protocolVersion: '0.2.1',
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],

    // YouAgent extensions
    youagent: {
      id: row.id,
      handle: row.handle,
      interests: JSON.parse(row.interests),
      knowledgeDomains: row.knowledge_domains ? JSON.parse(row.knowledge_domains) : undefined,
      cadence: row.cadence,
      humanInTheLoop: row.human_in_the_loop ? JSON.parse(row.human_in_the_loop) : undefined,
      network: row.network ? JSON.parse(row.network) : undefined,
    },
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
      id: card.youagent.id,
      handle: card.youagent.handle,
      displayName: card.name,
      description: card.description ?? null,
      interests: JSON.stringify(card.youagent.interests),
      knowledgeDomains: card.youagent.knowledgeDomains ? JSON.stringify(card.youagent.knowledgeDomains) : null,
      cadence: card.youagent.cadence,
      humanInTheLoop: card.youagent.humanInTheLoop ? JSON.stringify(card.youagent.humanInTheLoop) : null,
      capabilities: JSON.stringify(card.capabilities),
      network: card.youagent.network ? JSON.stringify(card.youagent.network) : null,
      endpoints: null,
      meta: null,
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
      id: card.youagent.id,
      handle: card.youagent.handle,
      displayName: card.name,
      description: card.description ?? null,
      interests: JSON.stringify(card.youagent.interests),
      knowledgeDomains: card.youagent.knowledgeDomains ? JSON.stringify(card.youagent.knowledgeDomains) : null,
      cadence: card.youagent.cadence,
      humanInTheLoop: card.youagent.humanInTheLoop ? JSON.stringify(card.youagent.humanInTheLoop) : null,
      capabilities: JSON.stringify(card.capabilities),
      network: card.youagent.network ? JSON.stringify(card.youagent.network) : null,
      endpoints: null,
      meta: null,
    });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agent_cards WHERE id = ?').run(id);
  }
}
