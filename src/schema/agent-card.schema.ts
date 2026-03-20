import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Reusable patterns
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const CADENCE_REGEX =
  /^(\d+[mhd]|(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+))$/;

// ---------------------------------------------------------------------------
// A2A Protocol sub-schemas
// ---------------------------------------------------------------------------

const a2aProviderSchema = z.object({
  organization: z.string(),
  url: z.string().url(),
});

const a2aExtensionSchema = z.object({
  uri: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

const a2aCapabilitiesSchema = z.object({
  streaming: z.boolean().optional().default(false),
  pushNotifications: z.boolean().optional().default(false),
  stateTransitionHistory: z.boolean().optional().default(false),
  extensions: z.array(a2aExtensionSchema).optional(),
});

const a2aSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

const a2aInterfaceSchema = z.object({
  transport: z.string(),
  url: z.string().url(),
});

const a2aSecuritySchemeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apiKey'), name: z.string(), in: z.enum(['cookie', 'header', 'query']), description: z.string().optional() }),
  z.object({ type: z.literal('http'), scheme: z.string(), bearerFormat: z.string().optional(), description: z.string().optional() }),
  z.object({ type: z.literal('oauth2'), flows: z.record(z.unknown()), description: z.string().optional() }),
  z.object({ type: z.literal('openIdConnect'), openIdConnectUrl: z.string().url(), description: z.string().optional() }),
  z.object({ type: z.literal('mutualTLS'), description: z.string().optional() }),
]);

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
// Full Agent Card schema (A2A + YouAgent extensions)
// ---------------------------------------------------------------------------

export const agentCardSchema = z.object({
  // ── A2A base fields ─────────────────────────────────────────────────────
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.string().url(),
  version: z.string().default('0.1.0'),
  protocolVersion: z.string().default('0.2.1'),
  provider: a2aProviderSchema.optional(),
  capabilities: a2aCapabilitiesSchema.default({
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  }),
  skills: z.array(a2aSkillSchema).default([]),
  defaultInputModes: z.array(z.string()).default(['text/plain']),
  defaultOutputModes: z.array(z.string()).default(['text/plain']),
  supportedInterfaces: z.array(a2aInterfaceSchema).optional(),
  securitySchemes: z.record(a2aSecuritySchemeSchema).optional(),
  security: z.array(z.record(z.array(z.string()))).optional(),
  documentationUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),

  // ── YouAgent extensions ─────────────────────────────────────────────────
  youagent: youagentExtensionsSchema,
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AgentCardInput = z.input<typeof agentCardSchema>;
export type AgentCardOutput = z.output<typeof agentCardSchema>;

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a validated AgentCard from minimal input.
 *
 * Requires at minimum: handle, interests, cadence, and a URL.
 * Generates A2A skills from YouAgent capabilities, applies defaults for
 * all optional fields. Throws a `ZodError` if validation fails.
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
    url: input.url ?? 'http://localhost:3141',
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
