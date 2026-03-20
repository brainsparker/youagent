// ---------------------------------------------------------------------------
// Finding Extraction & Deduplication
// ---------------------------------------------------------------------------

import type { SearchResult } from '../client/types.js';
import type { YouSearchClient } from '../client/you-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single finding extracted from search results. */
export interface Finding {
  /** Headline or title of the finding. */
  title: string;
  /** Short natural-language summary. */
  summary: string;
  /** Canonical URL of the source material. */
  sourceUrl: string;
  /** Human-readable attribution string (e.g. site name). */
  sourceAttribution: string;
  /** ISO 8601 publish date, if available. */
  publishedAt?: string;
  /** Tags indicating why this finding is relevant. */
  relevanceTags: string[];
  /** The interest topic that surfaced this finding. */
  interest: string;
}

/** Extracts structured findings from raw search result payloads. */
export interface FindingExtractor {
  extract(searchResults: SearchResult[], interest: string): Promise<Finding[]>;
}

// ---------------------------------------------------------------------------
// Stopwords used when extracting relevance tags
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
  'ought', 'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'how',
  'when', 'where', 'why', 'not', 'no', 'nor', 'as', 'if', 'then', 'than',
  'too', 'very', 'just', 'about', 'above', 'after', 'again', 'all', 'also',
  'am', 'any', 'because', 'before', 'between', 'both', 'each', 'few',
  'get', 'got', 'here', 'into', 'more', 'most', 'new', 'now', 'only',
  'other', 'over', 'own', 'same', 'so', 'some', 'still', 'such', 'there',
  'through', 'under', 'up', 'out', 'while', 'during', 'since',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the domain name from a URL (e.g. "www.example.com" -> "example.com"). */
function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Tokenise text into lower-case words, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Truncate a string to at most `maxWords` words.
 */
function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '…';
}

/**
 * Extract the top-N most frequent non-stopword terms from text.
 */
function extractTags(text: string, n: number): string[] {
  const words = tokenize(text);
  const freq = new Map<string, number>();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Default similarity threshold for deduplication. */
const DEDUP_THRESHOLD = 0.6;

export class FindingExtractorImpl implements FindingExtractor {
  constructor(private client?: YouSearchClient) {}

  /**
   * Extract findings from an array of search results.
   *
   * If a {@link YouSearchClient} was provided at construction time, each
   * snippet is summarised via the RAG answer endpoint.  Otherwise the raw
   * snippet is used (truncated to 200 words).
   */
  async extract(
    searchResults: SearchResult[],
    interest: string,
  ): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const result of searchResults) {
      const rawText = result.snippet || result.description || '';

      let summary: string;
      if (this.client && rawText.length > 0) {
        try {
          const answerResult = await this.client.answer(
            `Summarise the following in 2-3 concise sentences:\n\n${rawText}`,
          );
          summary = answerResult.answer || truncateWords(rawText, 200);
        } catch {
          // Fall back to raw snippet on any API failure.
          summary = truncateWords(rawText, 200);
        }
      } else {
        summary = truncateWords(rawText, 200);
      }

      const combinedText = `${result.title} ${rawText}`;

      const finding: Finding = {
        title: result.title,
        summary,
        sourceUrl: result.url,
        sourceAttribution: extractDomain(result.url),
        relevanceTags: extractTags(combinedText, 5),
        interest,
      };

      // SearchResult doesn't currently carry a publishedDate, but if one
      // is ever added we pass it through.
      const resultAny = result as unknown as Record<string, unknown>;
      if (typeof resultAny['publishedDate'] === 'string') {
        finding.publishedAt = resultAny['publishedDate'];
      }

      findings.push(finding);
    }

    return findings;
  }

  /**
   * Remove findings that are too similar to items already collected.
   *
   * Uses Jaccard similarity on the word-set of (title + summary).  Any new
   * finding whose similarity to *any* existing finding is >= 0.6 is dropped.
   */
  deduplicate(newFindings: Finding[], existingFindings: Finding[]): Finding[] {
    const kept: Finding[] = [];
    const all = [...existingFindings, ...kept];

    for (const candidate of newFindings) {
      const candidateText = `${candidate.title} ${candidate.summary}`;
      let isDuplicate = false;

      for (const existing of all) {
        const existingText = `${existing.title} ${existing.summary}`;
        if (this.similarity(candidateText, existingText) >= DEDUP_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        kept.push(candidate);
        all.push(candidate);
      }
    }

    return kept;
  }

  /**
   * Jaccard similarity index on word sets.
   *
   * J(A, B) = |A ∩ B| / |A ∪ B|
   */
  private similarity(a: string, b: string): number {
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));

    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
