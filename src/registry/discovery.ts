// ---------------------------------------------------------------------------
// AgentDiscovery — Local discovery logic for finding similar agents
// ---------------------------------------------------------------------------

import type { AgentCard } from "../types/agent-card.js";
import { getEffectiveInterests } from "../types/agent-card.js";

/**
 * Static utility class for local agent discovery and ranking based on
 * interest overlap.
 */
export class AgentDiscovery {
  /**
   * Calculate the interest overlap between two agent cards using the
   * Jaccard similarity coefficient on their topic sets.
   *
   * @param a  First agent card.
   * @param b  Second agent card.
   * @returns A value between 0 (no overlap) and 1 (identical topics).
   */
  static interestOverlap(a: AgentCard, b: AgentCard): number {
    const setA = new Set(getEffectiveInterests(a).map((t) => t.toLowerCase()));
    const setB = new Set(getEffectiveInterests(b).map((t) => t.toLowerCase()));

    if (setA.size === 0 && setB.size === 0) {
      return 0;
    }

    let intersectionSize = 0;
    for (const topic of setA) {
      if (setB.has(topic)) {
        intersectionSize++;
      }
    }

    const unionSize = setA.size + setB.size - intersectionSize;
    return unionSize === 0 ? 0 : intersectionSize / unionSize;
  }

  /**
   * Rank a list of agents by their relevance to a given set of interests.
   *
   * Relevance is computed as the fraction of the query interests that
   * appear in the agent's topic set, producing a score from 0 to 1.
   * Agents are returned in descending order of relevance.
   *
   * @param agents    The candidate agents to rank.
   * @param interests The interest topics to match against.
   * @returns A new array of agents sorted by descending relevance.
   */
  static rankByRelevance(
    agents: AgentCard[],
    interests: string[],
  ): AgentCard[] {
    const queryTopics = new Set(interests.map((t) => t.toLowerCase()));

    if (queryTopics.size === 0) {
      return [...agents];
    }

    const scored = agents.map((agent) => {
      const agentTopics = new Set(
        getEffectiveInterests(agent).map((t) => t.toLowerCase()),
      );

      let matchCount = 0;
      for (const topic of queryTopics) {
        if (agentTopics.has(topic)) {
          matchCount++;
        }
      }

      const score = matchCount / queryTopics.size;
      return { agent, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.agent);
  }

  /**
   * Filter agents whose interest overlap with the given card exceeds a
   * similarity threshold.
   *
   * @param agents     The candidate agents to filter.
   * @param card       The reference agent card.
   * @param threshold  Minimum Jaccard similarity (default 0.3).
   * @returns Agents with overlap >= threshold, sorted by descending overlap.
   */
  static filterByOverlap(
    agents: AgentCard[],
    card: AgentCard,
    threshold: number = 0.3,
  ): AgentCard[] {
    const scored = agents
      .map((agent) => ({
        agent,
        overlap: AgentDiscovery.interestOverlap(card, agent),
      }))
      .filter((s) => s.overlap >= threshold);

    scored.sort((a, b) => b.overlap - a.overlap);
    return scored.map((s) => s.agent);
  }
}
