// ---------------------------------------------------------------------------
// Heuristic Entity Extraction (V1)
// ---------------------------------------------------------------------------

import type { Finding } from '../engine/finding-extractor.js';
import type { EntityType } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An entity detected within a finding before persistence. */
export interface ExtractedEntity {
  name: string;
  type: EntityType;
  context: string; // surrounding text that led to extraction
}

// ---------------------------------------------------------------------------
// Known keyword sets
// ---------------------------------------------------------------------------

const TECH_KEYWORDS = new Set([
  'ai', 'ml', 'machine learning', 'deep learning', 'artificial intelligence',
  'blockchain', 'cryptocurrency', 'bitcoin', 'ethereum', 'web3',
  'cloud computing', 'kubernetes', 'docker', 'devops', 'cicd',
  'quantum computing', 'iot', 'internet of things', '5g', '6g',
  'cybersecurity', 'vpn', 'encryption', 'zero trust',
  'ar', 'vr', 'augmented reality', 'virtual reality', 'mixed reality',
  'robotics', 'automation', 'rpa', 'nlp', 'natural language processing',
  'computer vision', 'neural network', 'transformer', 'llm',
  'large language model', 'generative ai', 'gpt', 'diffusion model',
  'rust', 'golang', 'typescript', 'python', 'javascript', 'swift',
  'api', 'graphql', 'rest', 'grpc', 'microservices', 'serverless',
  'edge computing', 'fpga', 'gpu', 'tpu', 'semiconductor',
]);

/** Words that look capitalised but are not entity names. */
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'it', 'its', 'this', 'that', 'these', 'those', 'has', 'have', 'had',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'do', 'does',
  'did', 'not', 'no', 'so', 'if', 'as', 'new', 'how', 'what', 'when',
  'where', 'who', 'why', 'which', 'than', 'then', 'also', 'just', 'more',
  'most', 'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many',
  'much', 'own', 'other', 'into', 'over', 'after', 'before', 'between',
  'under', 'above', 'out', 'up', 'down', 'about', 'very', 'too',
  'says', 'said', 'according', 'report', 'reports', 'announced',
  'launches', 'launch', 'reveals', 'shows', 'plans', 'gets',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect capitalised multi-word phrases that likely represent named entities
 * (person or organisation names).
 */
function extractCapitalisedPhrases(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  // Match sequences of 2+ capitalised words (allows hyphens and apostrophes).
  const pattern = /\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const phrase = match[1];
    const words = phrase.split(/\s+/);

    // Filter out phrases where every word is a stop word.
    const meaningful = words.filter(
      (w) => !TITLE_STOPWORDS.has(w.toLowerCase()),
    );
    if (meaningful.length < 2) continue;

    // Simple heuristic: if the last word looks like a surname (single
    // capitalised word) and there are exactly 2–3 words, lean towards person.
    const type: EntityType =
      words.length <= 3 && /^[A-Z][a-z]+$/.test(words[words.length - 1])
        ? 'person'
        : 'organization';

    entities.push({ name: phrase, type, context: snippetAround(text, match.index, phrase.length) });
  }

  return entities;
}

/**
 * Detect known technology keywords in the text.
 */
function extractTechEntities(text: string): ExtractedEntity[] {
  const lower = text.toLowerCase();
  const entities: ExtractedEntity[] = [];

  for (const keyword of TECH_KEYWORDS) {
    const idx = lower.indexOf(keyword);
    if (idx !== -1) {
      // Verify word boundary (not a substring of a longer word).
      const before = idx > 0 ? lower[idx - 1] : ' ';
      const after = idx + keyword.length < lower.length ? lower[idx + keyword.length] : ' ';
      if (/\W/.test(before) && /\W/.test(after)) {
        entities.push({
          name: text.slice(idx, idx + keyword.length),
          type: 'technology',
          context: snippetAround(text, idx, keyword.length),
        });
      }
    }
  }

  return entities;
}

/**
 * Detect funding patterns like "$X million" or "$X billion" and attempt to
 * associate with a nearby organisation name.
 */
function extractFundingEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const pattern = /\$[\d,.]+\s*(?:million|billion|M|B)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Look backwards for a capitalised phrase that might be the org name.
    const preceding = text.slice(Math.max(0, match.index - 80), match.index);
    const orgMatch = /([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/.exec(preceding);
    if (orgMatch) {
      const name = orgMatch[1].trim();
      const words = name.split(/\s+/);
      const meaningful = words.filter(
        (w) => !TITLE_STOPWORDS.has(w.toLowerCase()),
      );
      if (meaningful.length >= 1) {
        entities.push({
          name,
          type: 'organization',
          context: snippetAround(text, match.index - name.length, name.length + match[0].length),
        });
      }
    }
  }

  return entities;
}

/**
 * Convert relevance tags into topic entities.
 */
function extractTopicEntities(finding: Finding): ExtractedEntity[] {
  return finding.relevanceTags.map((tag) => ({
    name: tag,
    type: 'topic' as EntityType,
    context: `Relevance tag for: ${finding.title}`,
  }));
}

/**
 * Return a short snippet of text centred around the match location.
 */
function snippetAround(text: string, offset: number, length: number): string {
  const radius = 40;
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + length + radius);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Deduplicate extracted entities by normalised name, preferring more specific
 * types over generic ones.
 */
function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const map = new Map<string, ExtractedEntity>();
  const typeSpecificity: Record<EntityType, number> = {
    person: 5,
    organization: 4,
    technology: 3,
    product: 3,
    event: 2,
    location: 2,
    topic: 1,
  };

  for (const entity of entities) {
    const key = entity.name.toLowerCase().trim().replace(/\s+/g, ' ');
    const existing = map.get(key);
    if (
      !existing ||
      typeSpecificity[entity.type] > typeSpecificity[existing.type]
    ) {
      map.set(key, entity);
    }
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Heuristic-based entity extractor (V1).
 *
 * Extracts persons, organisations, technologies and topics from a finding
 * using simple pattern-matching rules.  LLM-powered NER is planned for V2.
 */
export class EntityExtractor {
  /**
   * Extract entities from a {@link Finding}.
   */
  extract(finding: Finding): ExtractedEntity[] {
    const text = `${finding.title}. ${finding.summary}`;

    const entities: ExtractedEntity[] = [
      ...extractCapitalisedPhrases(text),
      ...extractTechEntities(text),
      ...extractFundingEntities(text),
      ...extractTopicEntities(finding),
    ];

    return deduplicateEntities(entities);
  }
}
