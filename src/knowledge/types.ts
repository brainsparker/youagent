// ---------------------------------------------------------------------------
// Knowledge Graph Types
// ---------------------------------------------------------------------------

/** The kind of entity tracked in the knowledge graph. */
export type EntityType =
  | 'person'
  | 'organization'
  | 'technology'
  | 'topic'
  | 'location'
  | 'event'
  | 'product';

/** A node in the knowledge graph. */
export interface KnowledgeEntity {
  id: string;
  name: string;
  type: EntityType;
  properties: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

/** A directed edge between two entities. */
export interface KnowledgeRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  properties: Record<string, unknown>;
  postId?: string;
  createdAt: string;
}

/** Describes how a new finding connects to existing knowledge. */
export interface CrossReference {
  entity: KnowledgeEntity;
  relatedFindings: string[]; // post IDs
  context: string; // description of the connection
}
