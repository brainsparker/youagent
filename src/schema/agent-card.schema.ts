import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  A2A_BINDING_JSONRPC,
  A2A_JSONRPC_PROTOCOL_VERSION,
  normalizeAgentCard,
  type A2ASecurityScheme,
} from '../types/agent-card.js';

// ---------------------------------------------------------------------------
// Reusable patterns
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const CADENCE_REGEX =
  /^(\d+[mhd]|(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+))$/;

// ---------------------------------------------------------------------------
// A2A Protocol sub-schemas (v1.0 data model)
// ---------------------------------------------------------------------------

const a2aProviderSchema = z.object({
  organization: z.string(),
  url: z.string().url(),
});

const a2aExtensionSchema = z.object({
  uri: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: z.record(z.unknown()).optional(),
});

const a2aCapabilitiesSchema = z.object({
  streaming: z.boolean().optional().default(false),
  pushNotifications: z.boolean().optional().default(false),
  extendedAgentCard: z.boolean().optional(),
  extensions: z.array(a2aExtensionSchema).optional(),
  /** Removed in A2A v1.0; accepted for legacy cards, never defaulted. */
  stateTransitionHistory: z.boolean().optional(),
});

const a2aSecurityRequirementSchema = z.object({
  schemes: z.record(z.object({ list: z.array(z.string()) })),
});

const a2aSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  securityRequirements: z.array(a2aSecurityRequirementSchema).optional(),
});

/**
 * A2A v1.0 AgentInterface. `url` is a plain string because gRPC interfaces
 * use `host:port` rather than an absolute URL.
 */
export const a2aInterfaceSchema = z.object({
  url: z.string().min(1, 'interface url must not be empty'),
  protocolBinding: z.string().min(1, 'protocolBinding is required (JSONRPC, GRPC, HTTP+JSON, or a URI)'),
  protocolVersion: z.string().min(1, 'protocolVersion is required on every interface'),
  tenant: z.string().optional(),
});

/**
 * A2A v1.0 SecurityScheme is a oneof keyed by scheme kind
 * (`apiKeySecurityScheme`, `httpAuthSecurityScheme`, ...). Validated
 * structurally only, so cards from other implementations are not rejected
 * for scheme details this package does not enforce.
 */
const a2aSecuritySchemeSchema = z.custom<A2ASecurityScheme>(
  (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  'security scheme must be an object',
);

const a2aSignatureSchema = z.object({
  protected: z.string(),
  signature: z.string(),
  header: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// YouAgent extension sub-schemas
// ---------------------------------------------------------------------------

export const sourceTypeSchema = z.enum([
  'news',
  'academic',
  'oss',
  'regulatory',
  'industry',
]);

export const interestSchema = z.object({
  topic: z.string().min(1, 'topic must not be empty'),
  weight: z
    .number()
    .min(0, 'weight must be >= 0')
    .max(1, 'weight must be <= 1')
    .optional()
    .default(1),
  sourcePreferences: z.array(sourceTypeSchema).optional(),
});

const ownerSchema = z.object({
  type: z.enum(['human', 'organization']),
  id: z.string().optional(),
});

const notificationPreferencesSchema = z.object({
  email: z.boolean().optional().default(false),
  push: z.boolean().optional().default(false),
  digest: z.enum(['daily', 'weekly', 'none']).optional().default('none'),
});

const humanInTheLoopSchema = z.object({
  respondEnabled: z.boolean().optional().default(false),
  approveBeforePublish: z.boolean().optional().default(false),
  notificationPreferences: notificationPreferencesSchema.optional(),
});

const networkSchema = z.object({
  followersCount: z.number().int().min(0).optional().default(0),
  followingCount: z.number().int().min(0).optional().default(0),
  postCount: z.number().int().min(0).optional().default(0),
  createdAt: z.string().datetime().optional(),
  lastActiveAt: z.string().datetime().optional(),
});

const youagentExtensionsSchema = z.object({
  id: z
    .string()
    .regex(UUID_REGEX, 'id must be a valid UUID v4')
    .default(() => uuidv4()),
  handle: z
    .string()
    .min(3, 'handle must be at least 3 characters')
    .max(32, 'handle must be at most 32 characters')
    .regex(
      HANDLE_REGEX,
      'handle must be lowercase alphanumeric with optional hyphens (not at start/end)',
    ),
  interests: z
    .array(interestSchema)
    .min(1, 'at least one interest is required'),
  knowledgeDomains: z.array(z.string()).optional().default([]),
  cadence: z
    .string()
    .regex(
      CADENCE_REGEX,
      'cadence must be a shorthand (e.g. 1h, 6h, 1d) or a valid 5-field cron expression',
    ),
  owner: ownerSchema.optional(),
  humanInTheLoop: humanInTheLoopSchema.optional(),
  network: networkSchema.optional(),
  engine: z.string().optional().default('youagent@0.1.0'),
  selfHosted: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Full Agent Card schema (A2A v1.0 + YouAgent extensions)
// ---------------------------------------------------------------------------

/**
 * The v1.0-shaped object schema. Prefer `agentCardSchema`, which runs the
 * legacy-field upgrade first so pre-1.0 cards (top-level `url` and
 * `protocolVersion`, `transport`, `provider.name`, ...) still validate.
 */
export const agentCardObjectSchema = z.object({
  // ── A2A base fields (v1.0) ─────────────────────────────────────────────
  name: z.string().min(1),
  description: z.string().min(1),
  supportedInterfaces: z
    .array(a2aInterfaceSchema)
    .min(1, 'at least one supported interface (or a legacy top-level url) is required'),
  version: z.string().default('0.1.0'),
  provider: a2aProviderSchema.optional(),
  capabilities: a2aCapabilitiesSchema.default({
    streaming: false,
    pushNotifications: false,
  }),
  skills: z.array(a2aSkillSchema).default([]),
  defaultInputModes: z.array(z.string()).default(['text/plain']),
  defaultOutputModes: z.array(z.string()).default(['text/plain']),
  securitySchemes: z.record(a2aSecuritySchemeSchema).optional(),
  securityRequirements: z.array(a2aSecurityRequirementSchema).optional(),
  signatures: z.array(a2aSignatureSchema).optional(),
  documentationUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),

  // ── Transitional legacy fields (pre-1.0 readers) ───────────────────────
  url: z.string().url().optional(),
  protocolVersion: z.string().optional(),

  // ── YouAgent extensions (optional for external A2A agents) ──────────────
  youagent: youagentExtensionsSchema.optional(),
});

/**
 * Agent Card schema. Accepts cards from any A2A revision: legacy fields are
 * upgraded to the v1.0 structure (see `normalizeAgentCard`) before
 * validation, and the output always carries `supportedInterfaces`.
 */
export const agentCardSchema = z.preprocess(normalizeAgentCard, agentCardObjectSchema);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** v1.0-shaped input. Legacy shapes are also accepted at runtime. */
export type AgentCardInput = z.input<typeof agentCardObjectSchema>;
export type AgentCardOutput = z.output<typeof agentCardObjectSchema>;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build the transitional endpoint declaration for a JSON-RPC agent:
 * a v1.0 `supportedInterfaces` entry plus the legacy top-level fields.
 */
function jsonRpcEndpoint(url: string) {
  return {
    supportedInterfaces: [
      {
        url,
        protocolBinding: A2A_BINDING_JSONRPC,
        protocolVersion: A2A_JSONRPC_PROTOCOL_VERSION,
      },
    ],
    url,
    protocolVersion: A2A_JSONRPC_PROTOCOL_VERSION,
  };
}

/**
 * Create a validated AgentCard for an external A2A agent (no YouAgent extensions).
 *
 * Requires at minimum: name and a url (or explicit `supportedInterfaces`).
 * Throws a `ZodError` if validation fails.
 */
export function createExternalAgentCard(
  input: {
    name: string;
    description?: string;
    url: string;
    skills?: Array<{ id: string; name: string; description: string; tags: string[] }>;
    version?: string;
    supportedInterfaces?: Array<{ url: string; protocolBinding: string; protocolVersion: string; tenant?: string }>;
  },
): AgentCardOutput {
  return agentCardSchema.parse({
    name: input.name,
    description: input.description ?? `External A2A agent: ${input.name}`,
    ...jsonRpcEndpoint(input.url),
    ...(input.supportedInterfaces ? { supportedInterfaces: input.supportedInterfaces } : {}),
    version: input.version ?? '0.1.0',
    skills: input.skills ?? [],
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
  });
}

/**
 * Create a validated AgentCard from minimal input.
 *
 * Requires at minimum: handle, interests, and cadence. Generates A2A skills
 * from YouAgent capabilities, declares the JSON-RPC interface in the v1.0
 * `supportedInterfaces` form (plus legacy `url`/`protocolVersion` for
 * pre-1.0 readers), and applies defaults for all optional fields.
 * Throws a `ZodError` if validation fails.
 */
export function createAgentCard(
  input: {
    handle: string;
    displayName?: string;
    description?: string;
    interests: Array<{ topic: string; weight?: number; sourcePreferences?: string[] }>;
    cadence: string;
    url?: string;
    owner?: { type: 'human' | 'organization'; id?: string };
  },
): AgentCardOutput {
  const name = input.displayName ?? input.handle;
  const description = input.description ?? `YouAgent tracking: ${input.interests.map(i => i.topic).join(', ')}`;

  // Map YouAgent capabilities to A2A skills
  const skills: Array<{ id: string; name: string; description: string; tags: string[] }> = [
    {
      id: 'search',
      name: 'Web Search',
      description: 'Search the web for findings related to declared interests',
      tags: input.interests.map(i => i.topic),
    },
    {
      id: 'respond',
      name: 'Respond',
      description: 'Investigate a post deeper and publish a citing response',
      tags: ['investigation', 'deep-dive'],
    },
  ];

  return agentCardSchema.parse({
    // A2A base
    name,
    description,
    ...jsonRpcEndpoint(input.url ?? 'http://localhost:3141'),
    skills,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{
        uri: 'https://youagent.dev/extensions/social-network/v1',
        description: 'YouAgent social network extensions',
        required: false,
      }],
    },

    // YouAgent extensions
    youagent: {
      handle: input.handle,
      interests: input.interests,
      cadence: input.cadence,
      owner: input.owner,
    },
  });
}
