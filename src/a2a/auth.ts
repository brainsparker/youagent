/**
 * A2A server authentication.
 *
 * The A2A specification leaves authentication to the HTTP layer: the agent
 * card declares which schemes it accepts (`securitySchemes`, section 4.4) and
 * which of them a caller must satisfy (`securityRequirements`), and the
 * server answers unauthenticated requests with HTTP 401 plus a
 * `WWW-Authenticate` challenge rather than a JSON-RPC error (section 3.2).
 *
 * This module implements the two schemes a self-hosted agent realistically
 * needs out of the box, static bearer tokens and static API keys, plus a
 * `verify` hook for anything else (JWTs, a shared secret store, mTLS
 * headers from a reverse proxy). Credentials are compared in constant time.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { A2ASecurityRequirement, A2ASecurityScheme, AgentCard } from '../types/agent-card.js';

/** Default header for API-key authentication. */
export const DEFAULT_API_KEY_HEADER = 'X-API-Key';

/** Name under which the bearer scheme is declared in `securitySchemes`. */
export const BEARER_SCHEME_NAME = 'bearer';
/** Name under which the API-key scheme is declared in `securitySchemes`. */
export const API_KEY_SCHEME_NAME = 'apiKey';

/** The credential a request presented, as extracted from its headers. */
export type A2ACredential =
  | { scheme: 'bearer'; token: string }
  | { scheme: 'apiKey'; key: string; header: string };

/**
 * What the server knows about an authenticated caller. Handlers receive it
 * on the JSON-RPC request object (`request.auth`).
 */
export interface A2AAuthContext {
  /** Which declared scheme satisfied the request. */
  scheme: 'bearer' | 'apiKey';
  /**
   * Caller identity as reported by a custom `verify` hook. Static tokens and
   * keys carry no identity, so this is undefined for them.
   */
  principal?: string;
}

/** Result of a custom `verify` hook. */
export type A2AVerifyResult = boolean | { principal?: string };

/** Authentication settings for `A2AServer`. */
export interface A2AAuthOptions {
  /**
   * Static tokens accepted in `Authorization: Bearer <token>`. Any listed
   * value grants access. Empty strings are ignored.
   */
  bearerTokens?: string[];
  /**
   * Static keys accepted in the API-key header (`apiKeyHeader`). Empty
   * strings are ignored.
   */
  apiKeys?: string[];
  /** Header carrying the API key. Defaults to `X-API-Key`. */
  apiKeyHeader?: string;
  /**
   * Custom verifier, consulted after the static lists fail (or instead of
   * them when none are configured). Return `true` or `{ principal }` to
   * accept, `false` to reject. Throwing rejects the request. Use this for
   * JWTs, a token database, or credentials minted per agent.
   */
  verify?: (credential: A2ACredential, req: IncomingMessage) => Promise<A2AVerifyResult> | A2AVerifyResult;
  /**
   * Also require authentication for the syndication feeds (`/feed.xml`,
   * `/feed.json`). Off by default: feeds exist so plain feed readers can
   * follow the agent, and they only expose posts the agent already
   * publishes. The agent card and `/health` are always public, as the spec
   * requires for discovery.
   */
  protectFeeds?: boolean;
  /**
   * Realm reported in the `WWW-Authenticate` challenge. Defaults to the
   * agent card name.
   */
  realm?: string;
}

/** Normalized view of the options, with the lists cleaned up. */
export interface ResolvedAuth {
  bearerTokens: string[];
  apiKeys: string[];
  apiKeyHeader: string;
  verify?: A2AAuthOptions['verify'];
  protectFeeds: boolean;
  realm?: string;
  /** Whether bearer tokens can satisfy a request (static list or verify hook). */
  acceptsBearer: boolean;
  /** Whether API keys can satisfy a request (static list or verify hook). */
  acceptsApiKey: boolean;
}

/**
 * Validate and normalize auth options. Throws when the configuration cannot
 * authenticate anyone, since silently running open would defeat the point.
 */
export function resolveAuth(options: A2AAuthOptions): ResolvedAuth {
  const bearerTokens = (options.bearerTokens ?? []).filter((t) => typeof t === 'string' && t.length > 0);
  const apiKeys = (options.apiKeys ?? []).filter((k) => typeof k === 'string' && k.length > 0);
  const apiKeyHeader = (options.apiKeyHeader ?? DEFAULT_API_KEY_HEADER).trim();

  if (apiKeyHeader.length === 0 || /[^\x21-\x7e]/.test(apiKeyHeader) || apiKeyHeader.includes(':')) {
    throw new Error(`Invalid apiKeyHeader "${options.apiKeyHeader}": must be a valid HTTP header name`);
  }
  if (apiKeyHeader.toLowerCase() === 'authorization') {
    throw new Error('apiKeyHeader must not be Authorization; that header carries bearer tokens');
  }
  if (bearerTokens.length === 0 && apiKeys.length === 0 && !options.verify) {
    throw new Error(
      'A2A auth is configured but accepts no credentials: set bearerTokens, apiKeys, or verify',
    );
  }

  const hasVerify = typeof options.verify === 'function';
  return {
    bearerTokens,
    apiKeys,
    apiKeyHeader,
    verify: options.verify,
    protectFeeds: options.protectFeeds === true,
    realm: options.realm,
    // With only a verify hook we cannot know which schemes it understands,
    // so both are offered to callers and the hook decides.
    acceptsBearer: bearerTokens.length > 0 || (hasVerify && apiKeys.length === 0),
    acceptsApiKey: apiKeys.length > 0 || (hasVerify && bearerTokens.length === 0),
  };
}

/**
 * Pull the credential out of a request. `Authorization: Bearer` wins over
 * the API-key header when both are present. Returns undefined when the
 * request carries neither.
 */
export function extractCredential(req: IncomingMessage, apiKeyHeader: string): A2ACredential | undefined {
  const authorization = headerValue(req.headers['authorization']);
  if (authorization) {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
    if (match) return { scheme: 'bearer', token: match[1]! };
  }
  const key = headerValue(req.headers[apiKeyHeader.toLowerCase()]);
  if (key) return { scheme: 'apiKey', key, header: apiKeyHeader };
  return undefined;
}

/**
 * Check a credential against the configuration. Returns the auth context on
 * success, undefined on failure. Never throws on a bad credential; a
 * throwing `verify` hook is treated as a rejection.
 */
export async function authenticate(
  credential: A2ACredential,
  auth: ResolvedAuth,
  req: IncomingMessage,
): Promise<A2AAuthContext | undefined> {
  const presented = credential.scheme === 'bearer' ? credential.token : credential.key;
  const accepted = credential.scheme === 'bearer' ? auth.bearerTokens : auth.apiKeys;

  // Compare against every configured value so timing does not reveal
  // which entry, if any, was close.
  let matched = false;
  for (const candidate of accepted) {
    if (secretsEqual(presented, candidate)) matched = true;
  }
  if (matched) return { scheme: credential.scheme };

  if (!auth.verify) return undefined;
  try {
    const result = await auth.verify(credential, req);
    if (result === true) return { scheme: credential.scheme };
    if (result && typeof result === 'object') {
      return result.principal === undefined
        ? { scheme: credential.scheme }
        : { scheme: credential.scheme, principal: result.principal };
    }
  } catch {
    // A failing verifier rejects the request; the reason stays server-side.
  }
  return undefined;
}

/**
 * Build the `WWW-Authenticate` header value for a 401 response: one
 * challenge per accepted scheme (RFC 9110 section 11.6.1). API keys have no
 * IANA scheme, so they are advertised as a Bearer challenge parameter plus
 * the header name in the JSON body.
 */
export function challengeHeader(auth: ResolvedAuth, realm: string): string {
  const quoted = `realm="${realm.replace(/["\\]/g, '')}"`;
  const challenges: string[] = [];
  if (auth.acceptsBearer) challenges.push(`Bearer ${quoted}`);
  if (auth.acceptsApiKey) challenges.push(`ApiKey ${quoted}, header="${auth.apiKeyHeader}"`);
  return challenges.join(', ');
}

/**
 * The `securitySchemes` block that describes this configuration, keyed the
 * way the served card declares them.
 */
export function securitySchemesFor(auth: ResolvedAuth): Record<string, A2ASecurityScheme> {
  const schemes: Record<string, A2ASecurityScheme> = {};
  if (auth.acceptsBearer) {
    schemes[BEARER_SCHEME_NAME] = {
      httpAuthSecurityScheme: { scheme: 'bearer', description: 'Authorization: Bearer <token>' },
    };
  }
  if (auth.acceptsApiKey) {
    schemes[API_KEY_SCHEME_NAME] = {
      apiKeySecurityScheme: {
        name: auth.apiKeyHeader,
        location: 'header',
        description: `${auth.apiKeyHeader}: <key>`,
      },
    };
  }
  return schemes;
}

/**
 * The `securityRequirements` list for this configuration: one alternative
 * per accepted scheme, meaning a caller satisfies any one of them.
 */
export function securityRequirementsFor(auth: ResolvedAuth): A2ASecurityRequirement[] {
  return Object.keys(securitySchemesFor(auth)).map((name) => ({ schemes: { [name]: { list: [] } } }));
}

/**
 * Return a copy of the card that declares the configured schemes. Schemes
 * the card already declares are kept (an embedder may describe an OAuth
 * flow the `verify` hook checks); the configured ones are merged in and
 * become required alternatives. The input card is not mutated.
 */
export function withDeclaredSecurity<T extends AgentCard>(card: T, auth: ResolvedAuth): T {
  const schemes = securitySchemesFor(auth);
  const existingSchemes = card.securitySchemes ?? {};
  const existingRequirements = card.securityRequirements ?? [];
  const requirements = securityRequirementsFor(auth).filter(
    (req) => !existingRequirements.some((existing) => sameRequirement(existing, req)),
  );
  return {
    ...card,
    securitySchemes: { ...existingSchemes, ...schemes },
    securityRequirements: [...existingRequirements, ...requirements],
  };
}

function sameRequirement(a: A2ASecurityRequirement, b: A2ASecurityRequirement): boolean {
  const aKeys = Object.keys(a.schemes ?? {}).sort();
  const bKeys = Object.keys(b.schemes ?? {}).sort();
  return aKeys.length === bKeys.length && aKeys.every((k, i) => k === bKeys[i]);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.length > 0 ? single : undefined;
}

/**
 * Constant-time string comparison. Inputs are hashed first so that lengths
 * never have to match (and never leak) before the comparison runs.
 */
function secretsEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
