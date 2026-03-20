// ---------------------------------------------------------------------------
// Knowledge Graph — persistence and querying
// ---------------------------------------------------------------------------

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import type { Finding } from '../engine/finding-extractor.js';
import { EntityExtractor } from './entity-extractor.js';
import type {
  CrossReference,
  EntityType,
  KnowledgeEntity,
  KnowledgeRelationship,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise an entity name for matching: lowercase, trim, collapse spaces. */
function normaliseName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Convert a database row to a {@link KnowledgeEntity}. */
function rowToEntity(row: Record<string, unknown>): KnowledgeEntity {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    type: row['type'] as EntityType,
    properties: row['properties']
      ? (JSON.parse(row['properties'] as string) as Record<string, unknown>)
      : {},
    firstSeen: row['first_seen'] as string,
    lastSeen: row['last_seen'] as string,
  };
}

/** Convert a database row to a {@link KnowledgeRelationship}. */
function rowToRelationship(
  row: Record<string, unknown>,
): KnowledgeRelationship {
  return {
    id: row['id'] as string,
    sourceEntityId: row['source_entity_id'] as string,
    targetEntityId: row['target_entity_id'] as string,
    relationshipType: row['relationship_type'] as string,
    properties: row['properties']
      ? (JSON.parse(row['properties'] as string) as Record<string, unknown>)
      : {},
    postId: (row['post_id'] as string) ?? undefined,
    createdAt: row['created_at'] as string,
  };
}

// ---------------------------------------------------------------------------
// KnowledgeGraph
// ---------------------------------------------------------------------------

/**
 * Manages the knowledge graph stored in SQLite.
 *
 * Entities and relationships are persisted in the `knowledge_entities` and
 * `knowledge_relationships` tables that are already created by
 * {@link AgentDatabase.initialize}.
 */
export class KnowledgeGraph {
  private extractor = new EntityExtractor();

  constructor(private db: Database.Database) {}

  // -----------------------------------------------------------------------
  // Ingestion
  // -----------------------------------------------------------------------

  /**
   * Extract entities from a finding and persist them (and their
   * co-occurrence relationships) in the graph.
   */
  async ingestFinding(finding: Finding, postId: string): Promise<void> {
    const extracted = this.extractor.extract(finding);
    if (extracted.length === 0) return;

    const now = new Date().toISOString();
    const entityIds: string[] = [];

    const upsertEntity = this.db.prepare(`
      INSERT INTO knowledge_entities (id, name, type, properties, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = excluded.last_seen,
        properties = excluded.properties
    `);

    const insertRelationship = this.db.prepare(`
      INSERT INTO knowledge_relationships (id, source_entity_id, target_entity_id, relationship_type, properties, post_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const ext of extracted) {
        const existing = this.findEntity(ext.name);
        if (existing) {
          // Update last_seen and merge properties.
          upsertEntity.run(
            existing.id,
            existing.name,
            existing.type,
            JSON.stringify({ ...existing.properties, latestContext: ext.context }),
            existing.firstSeen,
            now,
          );
          entityIds.push(existing.id);
        } else {
          const id = uuidv4();
          upsertEntity.run(
            id,
            ext.name,
            ext.type,
            JSON.stringify({ context: ext.context }),
            now,
            now,
          );
          entityIds.push(id);
        }
      }

      // Create co-occurrence relationships between all pairs.
      for (let i = 0; i < entityIds.length; i++) {
        for (let j = i + 1; j < entityIds.length; j++) {
          insertRelationship.run(
            uuidv4(),
            entityIds[i],
            entityIds[j],
            'co_occurrence',
            JSON.stringify({ source: 'finding', title: finding.title }),
            postId,
            now,
          );
        }
      }
    });

    transaction();
  }

  // -----------------------------------------------------------------------
  // Cross-referencing
  // -----------------------------------------------------------------------

  /**
   * For a new finding, determine which extracted entities already exist in the
   * graph and return {@link CrossReference} objects describing the connections.
   */
  crossReference(finding: Finding): CrossReference[] {
    const extracted = this.extractor.extract(finding);
    const refs: CrossReference[] = [];

    for (const ext of extracted) {
      const existing = this.findEntity(ext.name);
      if (!existing) continue;

      // Gather post IDs from relationships involving this entity.
      const rows = this.db
        .prepare(
          `SELECT DISTINCT post_id FROM knowledge_relationships
           WHERE (source_entity_id = ? OR target_entity_id = ?) AND post_id IS NOT NULL`,
        )
        .all(existing.id, existing.id) as Array<{ post_id: string }>;

      const postIds = rows.map((r) => r.post_id);

      refs.push({
        entity: existing,
        relatedFindings: postIds,
        context: `Entity "${existing.name}" (${existing.type}) was previously seen and is referenced in ${postIds.length} post(s).`,
      });
    }

    return refs;
  }

  // -----------------------------------------------------------------------
  // Querying
  // -----------------------------------------------------------------------

  /**
   * Search for entities whose name contains `query`.  Optionally filter by
   * {@link EntityType}.
   */
  queryEntities(query: string, type?: EntityType): KnowledgeEntity[] {
    const normalised = `%${normaliseName(query)}%`;

    if (type) {
      const rows = this.db
        .prepare(
          `SELECT * FROM knowledge_entities
           WHERE LOWER(name) LIKE ? AND type = ?
           ORDER BY last_seen DESC`,
        )
        .all(normalised, type) as Array<Record<string, unknown>>;
      return rows.map(rowToEntity);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE LOWER(name) LIKE ?
         ORDER BY last_seen DESC`,
      )
      .all(normalised) as Array<Record<string, unknown>>;
    return rows.map(rowToEntity);
  }

  /**
   * Return all relationships where the given entity is either source or
   * target.
   */
  getRelationships(entityId: string): KnowledgeRelationship[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_relationships
         WHERE source_entity_id = ? OR target_entity_id = ?
         ORDER BY created_at DESC`,
      )
      .all(entityId, entityId) as Array<Record<string, unknown>>;
    return rows.map(rowToRelationship);
  }

  /**
   * Return all entities, optionally limited.
   */
  getAllEntities(limit?: number): KnowledgeEntity[] {
    const sql = limit
      ? `SELECT * FROM knowledge_entities ORDER BY last_seen DESC LIMIT ?`
      : `SELECT * FROM knowledge_entities ORDER BY last_seen DESC`;
    const rows = (
      limit ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToEntity);
  }

  /**
   * Find a single entity by name using case-insensitive normalised matching.
   * Returns `null` when no match is found.
   */
  findEntity(name: string): KnowledgeEntity | null {
    const normalised = normaliseName(name);

    // Exact normalised match first.
    let row = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE LOWER(REPLACE(REPLACE(REPLACE(name, '  ', ' '), CHAR(9), ' '), CHAR(10), ' ')) = ?
         LIMIT 1`,
      )
      .get(normalised) as Record<string, unknown> | undefined;

    if (row) return rowToEntity(row);

    // Fuzzy fallback: LIKE match.
    row = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE LOWER(name) LIKE ?
         ORDER BY last_seen DESC
         LIMIT 1`,
      )
      .get(`%${normalised}%`) as Record<string, unknown> | undefined;

    return row ? rowToEntity(row) : null;
  }
}
