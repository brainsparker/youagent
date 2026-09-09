/**
 * Agent Card types for the YouAgent framework.
 *
 * Extends the A2A (Agent-to-Agent) protocol Agent Card specification, v1.0.
 * A2A base fields are defined first, then YouAgent-specific extensions.
 *
 * Cards produced by this package are "transitional": they carry the v1.0
 * structure (`supportedInterfaces`) and also the legacy v0.x top-level
 * `url` and `protocolVersion` fields, so both v1.0 clients and older
 * readers can address the agent. See `toV1AgentCard` to emit a strict
 * v1.0 card without the legacy fields.
 *
 * Spec: https://a2a-protocol.org/latest/specification/
 * Normative data model: https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto
 */

// ── A2A Protocol Constants ─────────────────────────────────────────────────

/** Version of the A2A Agent Card structure this package emits. */
export const A2A_CARD_VERSION = '1.0';

/**
 * Protocol version spoken by the JSON-RPC interface served by `A2AServer`.
 * The wire format (parts with `type`, lowercase task states) is still the
 * pre-1.0 shape, so the interface declares that honestly. A v1.0 card is
 * allowed to advertise interfaces at any protocol version.
 */
export const A2A_JSONRPC_PROTOCOL_VERSION = '0.2.1';

/** Core protocol binding identifiers defined by A2A v1.0. */
export const A2A_BINDING_JSONRPC = 'JSONRPC';
export const A2A_BINDING_GRPC = 'GRPC';
export const A2A_BINDING_HTTP_JSON = 'HTTP+JSON';

/** RFC 8615 well-known path for Agent Card discovery (A2A v1.0). */
export const A2A_WELL_KNOWN_PATH = '/.well-known/agent-card.json';

/** Pre-1.0 well-known path, still served and probed for compatibility. */
export const A2A_LEGACY_WELL_KNOWN_PATH = '/.well-known/agent.json';

/** Media type registered for Agent Cards in A2A v1.0 (spec section 14.1). */
export const A2A_CARD_MEDIA_TYPE = 'application/a2a+json';

// ── A2A Protocol Base Types ─────────────────────────────────────────────────

/** A2A AgentProvider: organization providing the agent. */
export interface A2AAgentProvider {
  organization: string;
  url: string;
}

/** A2A AgentCapabilities: protocol-level feature flags. */
export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  /** True when an authenticated extended card is available (v1.0). */
  extendedAgentCard?: boolean;
  extensions?: A2AAgentExtension[];
  /**
   * @deprecated Removed from the spec in A2A v1.0. Accepted on input for
   * legacy cards but never emitted by `createAgentCard`.
   */
  stateTransitionHistory?: boolean;
}

/** A2A AgentExtension: protocol extension declaration. */
export interface A2AAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

/** A2A AgentSkill: a capability the agent exposes on the network. */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  /** Required in v1.0: skill-level discovery filters on tags. */
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: A2ASecurityRequirement[];
}

/**
 * A2A AgentInterface (v1.0): one reachable endpoint of the agent.
 * The first entry in `supportedInterfaces` is the preferred interface.
 */
export interface A2AAgentInterface {
  /** Absolute URL (HTTP bindings) or host:port (gRPC). */
  url: string;
  /** 'JSONRPC', 'GRPC', 'HTTP+JSON', or a URI for a custom binding. */
  protocolBinding: string;
  /** A2A protocol version spoken at this URL, e.g. '1.0' or '0.2.1'. */
  protocolVersion: string;
  /** Optional opaque routing identifier for multi-tenant deployments. */
  tenant?: string;
}

/** A2A SecurityScheme (v1.0): a oneof keyed by scheme kind. */
export type A2ASecurityScheme =
  | { apiKeySecurityScheme: { name: string; location: string; description?: string } }
  | { httpAuthSecurityScheme: { scheme: string; bearerFormat?: string; description?: string } }
  | { oauth2SecurityScheme: { flows: Record<string, unknown>; oauth2MetadataUrl?: string; description?: string } }
  | { openIdConnectSecurityScheme: { openIdConnectUrl: string; description?: string } }
  | { mtlsSecurityScheme: { description?: string } };

/** A2A SecurityRequirement (v1.0): named schemes and the scopes each needs. */
export interface A2ASecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

/** A2A AgentCardSignature (v1.0): a detached JWS over the canonical card. */
export interface A2AAgentCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

/**
 * A2A Agent Card, v1.0 structure.
 * See: https://a2a-protocol.org/latest/specification/ (section 4.4)
 */
export interface A2AAgentCard {
  name: string;
  description: string;
  /** Ordered list of reachable interfaces; the first entry is preferred. */
  supportedInterfaces: A2AAgentInterface[];
  /** The agent's own release version (not the protocol version). */
  version: string;
  provider?: A2AAgentProvider;
  capabilities: A2AAgentCapabilities;
  skills: A2AAgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  securitySchemes?: Record<string, A2ASecurityScheme>;
  securityRequirements?: A2ASecurityRequirement[];
  signatures?: A2AAgentCardSignature[];
  documentationUrl?: string;
  iconUrl?: string;

  /**
   * @deprecated Pre-1.0 top-level endpoint. Kept on transitional cards so
   * pre-1.0 readers still find the agent. Prefer `getAgentUrl(card)`.
   */
  url?: string;
  /**
   * @deprecated Pre-1.0 top-level protocol version. In v1.0 the protocol
   * version lives on each entry of `supportedInterfaces`.
   */
  protocolVersion?: string;
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

/** Owner of an agent, either a human user or an organization. */
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
 * YouAgent Agent Card: extends the A2A AgentCard with YouAgent-specific fields.
 *
 * The A2A base fields make this card discoverable by any A2A-compliant agent.
 * The `youagent` extension namespace contains social network features.
 */
export interface AgentCard extends A2AAgentCard {
  /** YouAgent-specific extensions. Present only for native YouAgent cards. */
  youagent?: YouAgentExtensions;
}

// ── Helper functions for external agent compatibility ────────────────────────

/**
 * Type guard: returns true if the card has YouAgent extensions.
 */
export function isYouAgent(card: AgentCard): card is AgentCard & { youagent: YouAgentExtensions } {
  return card.youagent !== undefined;
}

/**
 * The preferred interface of a card: the first `supportedInterfaces` entry.
 * Falls back to a JSON-RPC interface built from the legacy `url` field so
 * cards that were persisted before v1.0 support keep working.
 */
export function getPrimaryInterface(card: A2AAgentCard): A2AAgentInterface | undefined {
  const first = card.supportedInterfaces?.[0];
  if (first) {
    return first;
  }
  if (card.url) {
    return {
      url: card.url,
      protocolBinding: A2A_BINDING_JSONRPC,
      protocolVersion: card.protocolVersion ?? A2A_JSONRPC_PROTOCOL_VERSION,
    };
  }
  return undefined;
}

/**
 * The URL to talk to this agent at: the preferred interface's URL, else the
 * legacy top-level `url`. Empty string when the card declares neither.
 */
export function getAgentUrl(card: A2AAgentCard): string {
  return getPrimaryInterface(card)?.url ?? card.url ?? '';
}

/**
 * Map a pre-1.0 `transport` value onto a v1.0 `protocolBinding`.
 * Unknown values pass through unchanged (custom bindings are allowed).
 */
export function toProtocolBinding(transport: string): string {
  switch (transport.trim().toLowerCase()) {
    case 'jsonrpc':
    case 'json-rpc':
      return A2A_BINDING_JSONRPC;
    case 'grpc':
      return A2A_BINDING_GRPC;
    case 'rest':
    case 'http':
    case 'http+json':
    case 'http_json':
      return A2A_BINDING_HTTP_JSON;
    default:
      return transport;
  }
}

/**
 * Upgrade a raw (untyped) agent card object from any A2A revision to the
 * v1.0 structure, without validating it.
 *
 * - `url` + `preferredTransport` + `additionalInterfaces` become an ordered
 *   `supportedInterfaces` array (existing entries are kept first).
 * - Interface entries using `transport` are renamed to `protocolBinding`;
 *   entries missing `protocolVersion` inherit the card's legacy value.
 * - `provider.name` becomes `provider.organization`.
 * - `supportsAuthenticatedExtendedCard` becomes `capabilities.extendedAgentCard`.
 * - `security` (pre-1.0 requirements) becomes `securityRequirements`.
 * - Legacy `url` and `protocolVersion` are kept (transitional card); `url`
 *   is filled from the preferred interface when missing.
 *
 * Non-object input is returned unchanged so schema validation can report it.
 */
export function normalizeAgentCard(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const card: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const legacyUrl = typeof card['url'] === 'string' ? (card['url'] as string) : undefined;
  const legacyProtocolVersion =
    typeof card['protocolVersion'] === 'string' ? (card['protocolVersion'] as string) : undefined;
  const fallbackVersion = legacyProtocolVersion ?? A2A_JSONRPC_PROTOCOL_VERSION;

  const normalizeInterface = (entry: unknown): Record<string, unknown> | undefined => {
    if (entry === null || typeof entry !== 'object') {
      return undefined;
    }
    const e = { ...(entry as Record<string, unknown>) };
    if (typeof e['protocolBinding'] !== 'string' && typeof e['transport'] === 'string') {
      e['protocolBinding'] = toProtocolBinding(e['transport'] as string);
    }
    delete e['transport'];
    if (typeof e['protocolVersion'] !== 'string') {
      e['protocolVersion'] = fallbackVersion;
    }
    return e;
  };

  const interfaces: Record<string, unknown>[] = [];
  if (Array.isArray(card['supportedInterfaces'])) {
    for (const entry of card['supportedInterfaces'] as unknown[]) {
      const normalized = normalizeInterface(entry);
      if (normalized) interfaces.push(normalized);
    }
  }
  if (interfaces.length === 0 && legacyUrl) {
    const preferred =
      typeof card['preferredTransport'] === 'string'
        ? toProtocolBinding(card['preferredTransport'] as string)
        : A2A_BINDING_JSONRPC;
    interfaces.push({ url: legacyUrl, protocolBinding: preferred, protocolVersion: fallbackVersion });
  }
  if (Array.isArray(card['additionalInterfaces'])) {
    for (const entry of card['additionalInterfaces'] as unknown[]) {
      const normalized = normalizeInterface(entry);
      if (normalized) interfaces.push(normalized);
    }
  }
  delete card['preferredTransport'];
  delete card['additionalInterfaces'];
  if (interfaces.length > 0) {
    card['supportedInterfaces'] = interfaces;
    if (!legacyUrl && typeof interfaces[0]['url'] === 'string') {
      card['url'] = interfaces[0]['url'];
    }
  }

  // provider.name (pre-1.0) -> provider.organization
  const provider = card['provider'];
  if (provider && typeof provider === 'object' && !Array.isArray(provider)) {
    const p = { ...(provider as Record<string, unknown>) };
    if (typeof p['organization'] !== 'string' && typeof p['name'] === 'string') {
      p['organization'] = p['name'];
    }
    delete p['name'];
    card['provider'] = p;
  }

  // supportsAuthenticatedExtendedCard (pre-1.0) -> capabilities.extendedAgentCard
  if (typeof card['supportsAuthenticatedExtendedCard'] === 'boolean') {
    const caps =
      card['capabilities'] && typeof card['capabilities'] === 'object'
        ? { ...(card['capabilities'] as Record<string, unknown>) }
        : {};
    if (typeof caps['extendedAgentCard'] !== 'boolean') {
      caps['extendedAgentCard'] = card['supportsAuthenticatedExtendedCard'];
    }
    card['capabilities'] = caps;
  }
  delete card['supportsAuthenticatedExtendedCard'];

  // security (pre-1.0) -> securityRequirements
  if (Array.isArray(card['security']) && !Array.isArray(card['securityRequirements'])) {
    card['securityRequirements'] = (card['security'] as unknown[]).map((req) => {
      if (req && typeof req === 'object' && !Array.isArray(req) && 'schemes' in (req as object)) {
        return req;
      }
      const schemes: Record<string, { list: string[] }> = {};
      if (req && typeof req === 'object') {
        for (const [name, scopes] of Object.entries(req as Record<string, unknown>)) {
          schemes[name] = { list: Array.isArray(scopes) ? (scopes as string[]) : [] };
        }
      }
      return { schemes };
    });
  }
  delete card['security'];

  return card;
}

/**
 * Return a strict A2A v1.0 card: the legacy top-level `url` and
 * `protocolVersion` are removed and the deprecated
 * `capabilities.stateTransitionHistory` flag is dropped.
 *
 * Use this when publishing to a v1.0-only registry or when you know every
 * consumer has migrated. `A2AServer` serves the transitional card by default.
 */
export function toV1AgentCard<T extends A2AAgentCard>(card: T): Omit<T, 'url' | 'protocolVersion'> {
  const { url: _url, protocolVersion: _protocolVersion, ...rest } = card;
  const { stateTransitionHistory: _history, ...capabilities } = rest.capabilities ?? {};
  return { ...rest, capabilities } as Omit<T, 'url' | 'protocolVersion'>;
}

/**
 * Extract effective interest topics from any agent card.
 * YouAgent cards use `youagent.interests`; external cards fall back to `skills[].tags`.
 */
export function getEffectiveInterests(card: AgentCard): string[] {
  if (isYouAgent(card)) {
    return card.youagent.interests.map((i) => i.topic);
  }
  const tags = new Set<string>();
  for (const skill of card.skills) {
    for (const tag of skill.tags) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Get a stable identifier and handle for any agent card.
 * YouAgent cards use `youagent.id` / `youagent.handle`; external cards derive
 * from the preferred interface URL and `name`.
 */
export function getAgentIdentifier(card: AgentCard): { id: string; handle: string } {
  if (isYouAgent(card)) {
    return { id: card.youagent.id, handle: card.youagent.handle };
  }
  // Derive handle from name: lowercase, replace non-alphanumeric with hyphens, trim
  const handle = card.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'external';
  return { id: getAgentUrl(card), handle };
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
