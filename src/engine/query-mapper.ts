/**
 * Interest-to-query mapping engine.
 *
 * Converts agent interests into concrete search queries that can be
 * dispatched to the You.com search API.  The mapper is fully
 * deterministic (no LLM calls) and rotates through query templates
 * to keep results diverse across successive runs.
 */

import type { Interest, SourceType } from '../types/agent-card.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchQuery {
  /** The search string to send to the API. */
  query: string;
  /** The originating interest topic. */
  interest: string;
  /** Which source preference produced this query (if any). */
  sourcePreference?: SourceType;
  /** Inherited relevance weight from the interest (0-1). */
  weight: number;
}

// ---------------------------------------------------------------------------
// Query templates
// ---------------------------------------------------------------------------

interface QueryTemplate {
  /** Generate the query string for a given topic. */
  build: (topic: string) => string;
  /** Which source preference this template is gated on (`undefined` = always). */
  sourcePreference?: SourceType;
  /** Stable key used for rotation tracking. */
  key: string;
}

const TEMPLATES: QueryTemplate[] = [
  { key: 'baseline', build: (t) => t },
  { key: 'developments', build: (t) => `${t} developments this week` },
  {
    key: 'news',
    sourcePreference: 'news',
    build: (t) => `latest ${t} news`,
  },
  {
    key: 'academic',
    sourcePreference: 'academic',
    build: (t) => `recent ${t} research papers`,
  },
  {
    key: 'oss',
    sourcePreference: 'oss',
    build: (t) => `new ${t} open source projects`,
  },
  {
    key: 'regulatory',
    sourcePreference: 'regulatory',
    build: (t) => `${t} policy updates regulations`,
  },
  {
    key: 'industry',
    sourcePreference: 'industry',
    build: (t) => `${t} industry trends analysis`,
  },
];

/** Templates used when the interest has no source preferences at all. */
const DEFAULT_TEMPLATE_KEYS = new Set(['baseline', 'news', 'developments']);

// ---------------------------------------------------------------------------
// QueryMapper
// ---------------------------------------------------------------------------

export class QueryMapper {
  /**
   * Track recently used template keys per interest topic so that
   * successive calls rotate through different templates.
   *
   * Map key = interest topic (lowercased), value = Set of template keys
   * used in the most recent generation for that topic.
   */
  private recentTemplates: Map<string, Set<string>> = new Map();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Generate search queries for a list of interests.
   *
   * Returns a flat array of {@link SearchQuery} objects, ordered by
   * descending weight then alphabetically by interest topic.
   */
  generateQueries(interests: Interest[]): SearchQuery[] {
    const queries: SearchQuery[] = interests.flatMap((interest) =>
      this.generateForInterest(interest),
    );

    // Sort: highest weight first, then alphabetical by interest topic.
    queries.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.interest.localeCompare(b.interest);
    });

    return queries;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Generate 3-5 diverse queries for a single interest.
   */
  private generateForInterest(interest: Interest): SearchQuery[] {
    const topic = interest.topic;
    const weight = interest.weight ?? 1;
    const prefs = interest.sourcePreferences;
    const topicKey = topic.toLowerCase();

    // Determine which templates are eligible for this interest.
    const eligible = this.getEligibleTemplates(prefs);

    // Apply rotation: deprioritise templates that were used on the
    // previous call for this same topic.
    const recent = this.recentTemplates.get(topicKey) ?? new Set<string>();
    const fresh = eligible.filter((t) => !recent.has(t.key));
    const stale = eligible.filter((t) => recent.has(t.key));

    // Prefer fresh templates, fall back to stale ones so we always
    // produce at least 3 queries.
    const ordered = [...fresh, ...stale];
    const selected = ordered.slice(0, 5);

    // Ensure we produce at least 3 (pad with the 'baseline' template
    // if for some reason there are fewer eligible templates).
    while (selected.length < 3) {
      const baseline = TEMPLATES.find((t) => t.key === 'baseline')!;
      if (!selected.includes(baseline)) {
        selected.push(baseline);
      } else {
        break; // avoid infinite loop; 1-2 queries is acceptable edge case
      }
    }

    // Record which templates we used this round.
    this.recentTemplates.set(
      topicKey,
      new Set(selected.map((t) => t.key)),
    );

    return selected.map((template) => ({
      query: template.build(topic),
      interest: topic,
      sourcePreference: template.sourcePreference,
      weight,
    }));
  }

  /**
   * Return the templates eligible for an interest given its source
   * preferences.  "Always-on" templates (no sourcePreference) are
   * included unconditionally; gated templates are included only when
   * the interest's preferences list contains the matching source type.
   *
   * When no source preferences are provided, a sensible default set
   * is returned (baseline + news + developments).
   */
  private getEligibleTemplates(
    prefs: SourceType[] | undefined,
  ): QueryTemplate[] {
    if (!prefs || prefs.length === 0) {
      return TEMPLATES.filter((t) => DEFAULT_TEMPLATE_KEYS.has(t.key));
    }

    const prefSet = new Set<SourceType>(prefs);

    return TEMPLATES.filter(
      (t) => t.sourcePreference === undefined || prefSet.has(t.sourcePreference),
    );
  }
}
