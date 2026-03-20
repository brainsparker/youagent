import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Reusable patterns
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Matches common cadence shorthands (`30m`, `1h`, `6h`, `1d`, `7d`) as well
 * as 5-field cron expressions (e.g. `0 * /6 * * *`).
 */
const CADENCE_REGEX =
  /^(\d+[mhd]|(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+))$/;

// ---------------------------------------------------------------------------
// Sub-schemas
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

const capabilitiesSchema = z.object({
  search: z.boolean().optional().default(true),
  respond: z.boolean().optional().default(false),
  crossReference: z.boolean().optional().default(false),
});

const networkSchema = z.object({
  followersCount: z.number().int().min(0).optional().default(0),
  followingCount: z.number().int().min(0).optional().default(0),
  postCount: z.number().int().min(0).optional().default(0),
  createdAt: z.string().datetime().optional(),
  lastActiveAt: z.string().datetime().optional(),
});

const endpointsSchema = z.object({
  a2a: z.string().url().optional(),
  profile: z.string().url().optional(),
});

const metaSchema = z
  .object({
    version: z.string().optional().default('1.0'),
    engine: z.string().optional().default('youagent@0.1.0'),
    selfHosted: z.boolean().optional().default(false),
  })
  .catchall(z.unknown());

// ---------------------------------------------------------------------------
// Agent Card schema
// ---------------------------------------------------------------------------

export const agentCardSchema = z.object({
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
  displayName: z.string().min(1, 'displayName must not be empty'),
  description: z.string().optional(),
  owner: ownerSchema.optional(),
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
  humanInTheLoop: humanInTheLoopSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
  network: networkSchema.optional(),
  endpoints: endpointsSchema.optional(),
  meta: metaSchema.optional(),
});

// ---------------------------------------------------------------------------
// Inferred types (useful for consumers who prefer Zod-derived types)
// ---------------------------------------------------------------------------

export type AgentCardInput = z.input<typeof agentCardSchema>;
export type AgentCardOutput = z.output<typeof agentCardSchema>;

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a validated AgentCard from partial input.
 *
 * Generates a UUID for `id` if not provided and applies sensible defaults
 * for all optional fields. Throws a `ZodError` if validation fails.
 */
export function createAgentCard(
  input: Omit<AgentCardInput, 'id'> & { id?: string },
): AgentCardOutput {
  return agentCardSchema.parse(input);
}
