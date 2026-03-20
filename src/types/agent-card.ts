/**
 * Agent Card types for the YouAgent framework.
 *
 * Properly extends the A2A (Agent-to-Agent) protocol Agent Card specification.
 * A2A base fields are defined first, then YouAgent-specific extensions.
 */

// ── A2A Protocol Base Types ─────────────────────────────────────────────────

/** A2A AgentProvider — organization providing the agent. */
export interface A2AAgentProvider {
  organization: string;
  url: string;
}

/** A2A AgentCapabilities — protocol-level feature flags. */
export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: A2AAgentExtension[];
}

/** A2A AgentExtension — protocol extension declaration. */
export interface A2AAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
}

/** A2A AgentSkill — a capability the agent exposes on the network. */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** A2A AgentInterface — protocol binding (JSON-RPC, gRPC, etc). */
export interface A2AAgentInterface {
  transport: string; // 'jsonrpc', 'grpc', 'rest'
  url: string;
}

/** A2A SecurityScheme — authentication configuration. */
export type A2ASecurityScheme =
  | { type: 'apiKey'; name: string; in: 'cookie' | 'header' | 'query'; description?: string }
  | { type: 'http'; scheme: string; bearerFormat?: string; description?: string }
  | { type: 'oauth2'; flows: Record<string, unknown>; description?: string }
  | { type: 'openIdConnect'; openIdConnectUrl: string; description?: string }
  | { type: 'mutualTLS'; description?: string };

/**
 * A2A Agent Card — the base protocol type.
 * See: https://a2a-protocol.org/latest/specification/
 */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  provider?: A2AAgentProvider;
  capabilities: A2AAgentCapabilities;
  skills: A2AAgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  supportedInterfaces?: A2AAgentInterface[];
  securitySchemes?: Record<string, A2ASecurityScheme>;
  security?: Record<string, string[]>[];
  documentationUrl?: string;
  iconUrl?: string;
}

// ── YouAgent Extension Types ────────────────────────────────────────────────

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

/** Owner of an agent — either a human user or an organization. */
export interface AgentOwner {
  type: 'human' | 'organization';
  /** Links to a For You account ID. */
  id?: string;
}

/** Human-in-the-loop configuration for agent oversight. */
export interface HumanInTheLoop {
  respondEnabled?: boolean;
  approveBeforePublish?: boolean;
  notificationPreferences?: {
    email?: boolean;
    push?: boolean;
    digest?: 'daily' | 'weekly' | 'none';
  };
}

/** Network statistics for an agent's social presence. */
export interface AgentNetwork {
  followersCount?: number;
  followingCount?: number;
  postCount?: number;
  createdAt?: string;
  lastActiveAt?: string;
}

/** YouAgent-specific extensions to the A2A Agent Card. */
export interface YouAgentExtensions {
  /** Unique identifier (UUID v4). */
  id: string;
  /** Unique handle; displayed with @ prefix. */
  handle: string;
  /** Topics the agent monitors. */
  interests: Interest[];
  /** Broad knowledge domains the agent covers. */
  knowledgeDomains?: string[];
  /** How often the agent runs. Cron expression or shorthand: '1h', '6h', '1d'. */
  cadence: string;
  /** Owner of the agent. */
  owner?: AgentOwner;
  /** Human oversight configuration. */
  humanInTheLoop?: HumanInTheLoop;
  /** Social-network statistics. */
  network?: AgentNetwork;
  /** Runtime engine identifier. */
  engine?: string;
  /** Whether the agent is self-hosted. */
  selfHosted?: boolean;
}

/**
 * YouAgent Agent Card — extends A2A AgentCard with YouAgent-specific fields.
 *
 * The A2A base fields make this card discoverable by any A2A-compliant agent.
 * The `youagent` extension namespace contains social network features.
 */
export interface AgentCard extends A2AAgentCard {
  /** YouAgent-specific extensions. */
  youagent: YouAgentExtensions;
}

// ── Legacy compat aliases ───────────────────────────────────────────────────
// These are used throughout the codebase and reference YouAgent extension fields.
// Access via card.youagent.* for the extension fields.

/** @deprecated Use A2AAgentCapabilities for protocol capabilities */
export interface AgentCapabilities {
  search?: boolean;
  respond?: boolean;
  crossReference?: boolean;
}

export interface AgentEndpoints {
  a2a?: string;
  profile?: string;
}

export interface AgentMeta {
  version?: string;
  engine?: string;
  selfHosted?: boolean;
  [key: string]: unknown;
}
