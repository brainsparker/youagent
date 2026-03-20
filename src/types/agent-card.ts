/**
 * Agent Card types for the YouAgent framework.
 * Extends the A2A (Agent-to-Agent) agent card specification.
 */

/** Source types an agent can prefer for gathering information. */
export type SourceType = 'news' | 'academic' | 'oss' | 'regulatory' | 'industry';

/** A topic interest with optional weight and source preferences. */
export interface Interest {
  topic: string;
  /** Relevance weight from 0 to 1. Defaults to 1. */
  weight?: number;
  /** Preferred source types for this interest. */
  sourcePreferences?: SourceType[];
}

/** Owner of an agent -- either a human user or an organization. */
export interface AgentOwner {
  type: 'human' | 'organization';
  /** Links to a For You account ID. */
  id?: string;
}

/** Human-in-the-loop configuration for agent oversight. */
export interface HumanInTheLoop {
  /** Whether the agent can accept replies from humans. */
  respondEnabled?: boolean;
  /** Whether posts require human approval before publishing. */
  approveBeforePublish?: boolean;
  /** Notification delivery preferences. */
  notificationPreferences?: {
    email?: boolean;
    push?: boolean;
    digest?: 'daily' | 'weekly' | 'none';
  };
}

/** Agent capability flags. */
export interface AgentCapabilities {
  search?: boolean;
  respond?: boolean;
  crossReference?: boolean;
}

/** Network statistics for an agent's social presence. */
export interface AgentNetwork {
  followersCount?: number;
  followingCount?: number;
  postCount?: number;
  /** ISO 8601 datetime when the agent was created. */
  createdAt?: string;
  /** ISO 8601 datetime of last activity. */
  lastActiveAt?: string;
}

/** Endpoint URLs for interacting with the agent. */
export interface AgentEndpoints {
  /** A2A protocol endpoint. */
  a2a?: string;
  /** Public profile URL. */
  profile?: string;
}

/** Extensible metadata about the agent runtime. */
export interface AgentMeta {
  version?: string;
  /** Runtime engine identifier, e.g. 'youagent@0.1.0'. */
  engine?: string;
  /** Whether the agent is self-hosted (vs. managed). */
  selfHosted?: boolean;
  [key: string]: unknown;
}

/**
 * The core Agent Card schema.
 *
 * An Agent Card is the public identity document for a YouAgent instance.
 * It describes who the agent is, what it cares about, how often it runs,
 * and how it can be reached.
 */
export interface AgentCard {
  /** Unique identifier (UUID v4). */
  id: string;
  /** Unique handle; displayed with @ prefix. Alphanumeric + hyphens, 3-32 chars. */
  handle: string;
  /** Human-readable display name. */
  displayName: string;
  /** Natural-language description of the agent's purpose. */
  description?: string;
  /** Owner of the agent. */
  owner?: AgentOwner;
  /** Topics the agent monitors. At least one required. */
  interests: Interest[];
  /** Broad knowledge domains the agent covers. */
  knowledgeDomains?: string[];
  /** How often the agent runs. Cron expression or shorthand: '1h', '6h', '1d'. */
  cadence: string;
  /** Human oversight configuration. */
  humanInTheLoop?: HumanInTheLoop;
  /** Feature flags. */
  capabilities?: AgentCapabilities;
  /** Social-network statistics. */
  network?: AgentNetwork;
  /** Reachability endpoints. */
  endpoints?: AgentEndpoints;
  /** Runtime metadata (extensible). */
  meta?: AgentMeta;
}
