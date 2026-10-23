/**
 * Agent Card signing and verification (A2A v1.0 specification section 8.4).
 *
 * A signed card carries one or more `AgentCardSignature` entries: detached
 * JSON Web Signatures (RFC 7515) over the card's canonical JSON form
 * (RFC 8785, JCS) with the `signatures` field itself excluded. A client that
 * fetched the card from a registry, a cache or a mirror can check that the
 * bytes were produced by whoever holds the signing key, and that nothing was
 * changed in transit.
 *
 * Everything here runs on `node:crypto`. Supported algorithms are the
 * asymmetric JWS algorithms a public card can sensibly use: ES256, ES384,
 * ES512, EdDSA (Ed25519), RS256 and PS256. Symmetric HMAC algorithms are
 * deliberately not supported: a card is public, so a shared secret would have
 * to be shared with every reader.
 *
 * Canonicalization follows the reference a2a-python SDK (`a2a.utils.signing`)
 * so cards signed by either implementation verify in the other: the
 * `signatures` field is removed, then null, empty strings, empty arrays and
 * empty objects are dropped recursively, then the result is serialized per
 * RFC 8785 (keys sorted by UTF-16 code units, ECMAScript number formatting,
 * minimal string escaping, no whitespace).
 */

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  constants as cryptoConstants,
  type KeyObject,
  type JsonWebKey,
} from 'node:crypto';
import type { AgentCard, A2AAgentCardSignature } from '../types/agent-card.js';

// ── Canonicalization (RFC 8785) ─────────────────────────────────────────────

/** Maximum nesting accepted by the canonicalizer; extension params are caller controlled. */
export const CANONICALIZATION_MAX_DEPTH = 128;

/** Thrown when a value has no RFC 8785 canonical form. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/** RFC 8785 output is UTF-8, and a lone surrogate has no UTF-8 encoding. */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Serialize a JSON value to its RFC 8785 (JCS) canonical form.
 *
 * `JSON.stringify` already produces the RFC 8785 rendering of every scalar
 * (ECMAScript `Number::toString`, minimal escaping with lowercase `\u00xx`),
 * so the work here is key ordering, whitespace and rejecting values that
 * have no canonical form (NaN, Infinity, functions, lone surrogates).
 */
export function canonicalizeJson(value: unknown, depth = 0): string {
  if (depth > CANONICALIZATION_MAX_DEPTH) {
    throw new CanonicalizationError(`nesting exceeds the maximum depth of ${CANONICALIZATION_MAX_DEPTH}`);
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(`${value} is not a JSON number`);
      return JSON.stringify(value);
    case 'string':
      if (hasUnpairedSurrogate(value)) {
        throw new CanonicalizationError('string contains an unpaired surrogate');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`${typeof value} has no JSON representation`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item, depth + 1)).join(',')}]`;
  }
  // Default string comparison orders by UTF-16 code unit, which is exactly
  // the RFC 8785 section 3.2.3 requirement.
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const members: string[] = [];
  for (const key of keys) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${canonicalizeJson(member, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

/**
 * Drop values the A2A canonical form omits: null/undefined, empty strings,
 * empty arrays and empty objects, recursively (a container that becomes
 * empty is dropped too). Mirrors a2a-python's `_clean_empty`.
 */
export function removeEmptyValues(value: unknown, depth = 0): unknown {
  if (depth > CANONICALIZATION_MAX_DEPTH) {
    throw new CanonicalizationError(`nesting exceeds the maximum depth of ${CANONICALIZATION_MAX_DEPTH}`);
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (Array.isArray(value)) {
    const items = value.map((item) => removeEmptyValues(item, depth + 1)).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = removeEmptyValues(member, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

/**
 * The exact bytes a card signature covers: the card without `signatures`,
 * empty values removed, in RFC 8785 canonical form. Both signing and
 * verification go through this function.
 */
export function agentCardSigningPayload(card: unknown): string {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    throw new CanonicalizationError('an agent card must be a JSON object');
  }
  const { signatures: _signatures, ...rest } = card as Record<string, unknown>;
  const cleaned = removeEmptyValues(rest) ?? {};
  return canonicalizeJson(cleaned);
}

// ── Algorithms and keys ─────────────────────────────────────────────────────

/** JWS algorithms accepted for card signatures. */
export type CardSigningAlgorithm = 'ES256' | 'ES384' | 'ES512' | 'EdDSA' | 'RS256' | 'PS256';

export const CARD_SIGNING_ALGORITHMS: readonly CardSigningAlgorithm[] = [
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'RS256',
  'PS256',
];

/** Well-known path where an agent publishes the public keys its card is signed with. */
export const A2A_JWKS_PATH = '/.well-known/jwks.json';

/** JWS protected header of a card signature (RFC 7515 section 4). */
export interface CardSignatureProtectedHeader {
  alg: string;
  kid: string;
  typ?: string;
  jku?: string;
  [param: string]: unknown;
}

/** A JWK Set document (RFC 7517 section 5). */
export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

const EC_CURVE_BY_ALG: Record<string, string> = {
  ES256: 'prime256v1',
  ES384: 'secp384r1',
  ES512: 'secp521r1',
};

const HASH_BY_ALG: Record<string, string> = {
  ES256: 'sha256',
  ES384: 'sha384',
  ES512: 'sha512',
  RS256: 'sha256',
  PS256: 'sha256',
};

function isSigningAlgorithm(alg: unknown): alg is CardSigningAlgorithm {
  return typeof alg === 'string' && (CARD_SIGNING_ALGORITHMS as readonly string[]).includes(alg);
}

/**
 * Check that a key can be used with an algorithm. This is the guard against
 * algorithm confusion: a signature's `alg` is attacker controlled, and the
 * key it is checked against must be of the matching type and curve.
 */
export function keyMatchesAlgorithm(key: KeyObject, alg: CardSigningAlgorithm): boolean {
  const type = key.asymmetricKeyType;
  switch (alg) {
    case 'ES256':
    case 'ES384':
    case 'ES512':
      return type === 'ec' && key.asymmetricKeyDetails?.namedCurve === EC_CURVE_BY_ALG[alg];
    case 'EdDSA':
      return type === 'ed25519';
    case 'RS256':
      return type === 'rsa';
    case 'PS256':
      return type === 'rsa' || type === 'rsa-pss';
    default:
      return false;
  }
}

/** Pick the natural JWS algorithm for a key: its curve for EC, EdDSA for Ed25519, RS256 for RSA. */
export function defaultAlgorithmForKey(key: KeyObject): CardSigningAlgorithm {
  switch (key.asymmetricKeyType) {
    case 'ec': {
      const curve = key.asymmetricKeyDetails?.namedCurve;
      const alg = (Object.keys(EC_CURVE_BY_ALG) as CardSigningAlgorithm[]).find((a) => EC_CURVE_BY_ALG[a] === curve);
      if (!alg) throw new Error(`Unsupported EC curve for card signing: ${curve ?? 'unknown'}`);
      return alg;
    }
    case 'ed25519':
      return 'EdDSA';
    case 'rsa':
      return 'RS256';
    case 'rsa-pss':
      return 'PS256';
    default:
      throw new Error(`Unsupported key type for card signing: ${key.asymmetricKeyType ?? 'unknown'}`);
  }
}

/** Anything `signAgentCard` accepts as a private key. */
export type PrivateKeyInput = KeyObject | string | Buffer | JsonWebKey;

/** Anything `verifyAgentCardSignatures` accepts as a public key. */
export type PublicKeyInput = KeyObject | string | Buffer | JsonWebKey;

function toPrivateKey(input: PrivateKeyInput): KeyObject {
  if (typeof input === 'object' && !Buffer.isBuffer(input) && 'type' in input && typeof (input as KeyObject).export === 'function') {
    const key = input as KeyObject;
    if (key.type !== 'private') throw new Error('signAgentCard needs a private key');
    return key;
  }
  if (typeof input === 'string' || Buffer.isBuffer(input)) return createPrivateKey(input);
  return createPrivateKey({ key: input as JsonWebKey, format: 'jwk' });
}

/** Coerce a PEM, DER, JWK or KeyObject into a public KeyObject (a private key yields its public half). */
export function toPublicKey(input: PublicKeyInput): KeyObject {
  if (typeof input === 'object' && !Buffer.isBuffer(input) && 'type' in input && typeof (input as KeyObject).export === 'function') {
    const key = input as KeyObject;
    return key.type === 'private' ? createPublicKey(key) : key;
  }
  if (typeof input === 'string' || Buffer.isBuffer(input)) return createPublicKey(input);
  return createPublicKey({ key: input as JsonWebKey, format: 'jwk' });
}

/**
 * Export the public half of a key as a JWK ready for a JWK Set: `kid`, `alg`
 * and `use: "sig"` are stamped on so verifiers can select it by `kid`.
 */
export function toPublicJwk(
  key: PublicKeyInput,
  options: { kid: string; alg?: CardSigningAlgorithm },
): JsonWebKey {
  const publicKey = toPublicKey(key);
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  return { ...jwk, kid: options.kid, alg: options.alg ?? defaultAlgorithmForKey(publicKey), use: 'sig' };
}

/** Generate a fresh signing key pair. Defaults to ES256 (P-256), the algorithm the spec's examples use. */
export function generateCardSigningKeyPair(alg: CardSigningAlgorithm = 'ES256'): {
  alg: CardSigningAlgorithm;
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  switch (alg) {
    case 'ES256':
    case 'ES384':
    case 'ES512': {
      const pair = generateKeyPairSync('ec', { namedCurve: EC_CURVE_BY_ALG[alg]! });
      return { alg, ...pair };
    }
    case 'EdDSA': {
      const pair = generateKeyPairSync('ed25519');
      return { alg, ...pair };
    }
    case 'RS256':
    case 'PS256': {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return { alg, ...pair };
    }
    default:
      throw new Error(`Unsupported card signing algorithm: ${String(alg)}`);
  }
}

// ── JWS primitives ──────────────────────────────────────────────────────────

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function signingInput(protectedB64: string, payload: string): Buffer {
  return Buffer.from(`${protectedB64}.${base64url(payload)}`, 'ascii');
}

function rawSign(alg: CardSigningAlgorithm, data: Buffer, key: KeyObject): Buffer {
  switch (alg) {
    case 'ES256':
    case 'ES384':
    case 'ES512':
      return cryptoSign(HASH_BY_ALG[alg]!, data, { key, dsaEncoding: 'ieee-p1363' });
    case 'EdDSA':
      return cryptoSign(null, data, key);
    case 'RS256':
      return cryptoSign('sha256', data, key);
    case 'PS256':
      return cryptoSign('sha256', data, {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      });
  }
}

function rawVerify(alg: CardSigningAlgorithm, data: Buffer, key: KeyObject, signature: Buffer): boolean {
  try {
    switch (alg) {
      case 'ES256':
      case 'ES384':
      case 'ES512':
        return cryptoVerify(HASH_BY_ALG[alg]!, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'EdDSA':
        return cryptoVerify(null, data, key, signature);
      case 'RS256':
        return cryptoVerify('sha256', data, key, signature);
      case 'PS256':
        return cryptoVerify(
          'sha256',
          data,
          { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
          signature,
        );
    }
  } catch {
    return false;
  }
}

/** Decode a signature's protected header. Throws on malformed input. */
export function decodeProtectedHeader(signature: A2AAgentCardSignature): CardSignatureProtectedHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(signature.protected, 'base64url').toString('utf8'));
  } catch {
    throw new AgentCardSignatureError('malformed_signature', 'protected header is not base64url JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentCardSignatureError('malformed_signature', 'protected header must be a JSON object');
  }
  const header = parsed as Record<string, unknown>;
  if (typeof header['alg'] !== 'string' || typeof header['kid'] !== 'string') {
    throw new AgentCardSignatureError('malformed_signature', 'protected header needs string alg and kid');
  }
  return header as CardSignatureProtectedHeader;
}

// ── Signing ─────────────────────────────────────────────────────────────────

export interface SignAgentCardOptions {
  /** Private key: KeyObject, PEM/DER string or buffer, or a private JWK. */
  key: PrivateKeyInput;
  /** Key identifier written to the protected header; verifiers select the public key by it. */
  kid: string;
  /** JWS algorithm. Defaults to the key's natural algorithm (ES256 for P-256, EdDSA for Ed25519, RS256 for RSA). */
  alg?: CardSigningAlgorithm;
  /** URL of the JWK Set holding the public key, written to the protected header as `jku`. */
  jku?: string;
  /** Extra protected header parameters. `alg`, `kid`, `typ` and `jku` cannot be overridden. */
  protectedHeader?: Record<string, unknown>;
  /** Unprotected JWS header, copied verbatim onto the signature. */
  header?: Record<string, unknown>;
}

/**
 * Sign an agent card. Returns a copy with the new signature appended to
 * `signatures`; existing signatures are kept so keys can be rotated by
 * signing with both the old and the new key for a while.
 */
export function signAgentCard<T extends AgentCard>(card: T, options: SignAgentCardOptions): T {
  const key = toPrivateKey(options.key);
  const alg = options.alg ?? defaultAlgorithmForKey(key);
  if (!keyMatchesAlgorithm(key, alg)) {
    throw new Error(`Key type ${key.asymmetricKeyType ?? 'unknown'} cannot sign with ${alg}`);
  }
  if (!options.kid) throw new Error('signAgentCard needs a kid');

  const protectedHeader: CardSignatureProtectedHeader = {
    ...(options.protectedHeader ?? {}),
    alg,
    typ: 'JOSE',
    kid: options.kid,
    ...(options.jku ? { jku: options.jku } : {}),
  };
  const protectedB64 = base64url(JSON.stringify(protectedHeader));
  const payload = agentCardSigningPayload(card);
  const signature = base64url(rawSign(alg, signingInput(protectedB64, payload), key));

  const entry: A2AAgentCardSignature = { protected: protectedB64, signature };
  if (options.header) entry.header = options.header;
  return { ...card, signatures: [...(card.signatures ?? []), entry] };
}

// ── Verification ────────────────────────────────────────────────────────────

export type AgentCardSignatureErrorCode =
  | 'no_signatures'
  | 'malformed_signature'
  | 'invalid_signatures'
  | 'canonicalization_failed';

/** Thrown when a card's signatures cannot be verified. */
export class AgentCardSignatureError extends Error {
  constructor(
    public readonly code: AgentCardSignatureErrorCode,
    message: string,
    /** Per-signature reasons collected while trying each entry. */
    public readonly attempts: SignatureAttempt[] = [],
  ) {
    super(message);
    this.name = 'AgentCardSignatureError';
  }
}

/** Outcome of checking one `signatures` entry. */
export interface SignatureAttempt {
  index: number;
  kid?: string;
  alg?: string;
  jku?: string;
  ok: boolean;
  reason?: string;
}

/** A successful verification: which signature verified and with what. */
export interface AgentCardVerification {
  index: number;
  kid: string;
  alg: CardSigningAlgorithm;
  jku?: string;
  protectedHeader: CardSignatureProtectedHeader;
  /** Every signature tried, including the ones that failed before this one passed. */
  attempts: SignatureAttempt[];
}

/**
 * Resolve the public key for a signature. Return `undefined` when no key is
 * known for it; the signature is then skipped and the next one is tried.
 */
export type CardKeyResolver = (
  header: CardSignatureProtectedHeader,
  context: { card: AgentCard },
) => PublicKeyInput | undefined | Promise<PublicKeyInput | undefined>;

/** Where a verifier may fetch a JWK Set from when a signature carries `jku`. */
export interface JwksFetchPolicy {
  /**
   * Origins (scheme + host + port) whose JWKS URLs are trusted, or `"any"`.
   * A `jku` is attacker controlled: a forged card can point at a JWKS the
   * forger publishes, so only follow it to origins you already trust. For a
   * card fetched from `https://agent.example`, pass that origin: the
   * signature then proves the card was issued by whoever controls the host
   * it was served from, which is what protects registries and mirrors.
   */
  origins: string[] | 'any';
  /** Require `https:` JWKS URLs. Defaults to true; `http:` is always allowed for loopback hosts. */
  requireHttps?: boolean;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 10 000 ms. */
  timeoutMs?: number;
}

export interface VerifyAgentCardOptions {
  /**
   * Trusted public keys. JWKs are matched by `kid`; a single key without a
   * `kid` (or a bare KeyObject/PEM) is tried for every signature.
   */
  keys?: PublicKeyInput[] | JsonWebKeySet;
  /** Custom key lookup, consulted after `keys` and before any JWKS fetch. */
  resolveKey?: CardKeyResolver;
  /** Fetch keys from the signature's `jku` under this policy. Off when omitted. */
  jwks?: JwksFetchPolicy;
  /** Acceptable algorithms. Defaults to every supported asymmetric algorithm. */
  algorithms?: CardSigningAlgorithm[];
}

const JWKS_DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

/** Is this JWKS URL allowed under the policy? Exported for callers that build their own resolvers. */
export function jkuAllowed(jku: string, policy: JwksFetchPolicy): boolean {
  let url: URL;
  try {
    url = new URL(jku);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if ((policy.requireHttps ?? true) && url.protocol !== 'https:' && !isLoopback(url)) return false;
  if (policy.origins === 'any') return true;
  return policy.origins.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}

/** Fetch a JWK Set document. */
export async function fetchJwks(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<JsonWebKeySet> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? JWKS_DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status} from ${url}`);
    const body: unknown = await res.json();
    if (body === null || typeof body !== 'object' || !Array.isArray((body as JsonWebKeySet).keys)) {
      throw new Error(`JWKS document at ${url} has no keys array`);
    }
    return body as JsonWebKeySet;
  } finally {
    clearTimeout(timer);
  }
}

function keyList(keys: PublicKeyInput[] | JsonWebKeySet | undefined): PublicKeyInput[] {
  if (!keys) return [];
  return Array.isArray(keys) ? keys : keys.keys;
}

function isJwk(input: PublicKeyInput): input is JsonWebKey {
  return typeof input === 'object' && !Buffer.isBuffer(input) && !('export' in input) && 'kty' in input;
}

/** Pick the keys from a list that could belong to a signature: matching `kid`, or keys with no `kid` at all. */
function candidateKeys(keys: PublicKeyInput[], kid: string): PublicKeyInput[] {
  return keys.filter((key) => !isJwk(key) || key.kid === undefined || key.kid === kid);
}

/**
 * Verify an agent card's signatures. Succeeds when at least one signature
 * verifies with a key the caller trusts (spec section 8.4.3); otherwise
 * throws `AgentCardSignatureError` with a per-signature account of why.
 */
export async function verifyAgentCardSignatures(
  card: AgentCard,
  options: VerifyAgentCardOptions,
): Promise<AgentCardVerification> {
  const signatures = card.signatures ?? [];
  if (signatures.length === 0) {
    throw new AgentCardSignatureError('no_signatures', 'agent card has no signatures to verify');
  }
  const algorithms = options.algorithms ?? CARD_SIGNING_ALGORITHMS;

  let payload: string;
  try {
    payload = agentCardSigningPayload(card);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentCardSignatureError('canonicalization_failed', `agent card cannot be canonicalized: ${message}`);
  }

  const attempts: SignatureAttempt[] = [];
  const jwksCache = new Map<string, Promise<JsonWebKeySet>>();

  for (const [index, entry] of signatures.entries()) {
    const attempt: SignatureAttempt = { index, ok: false };
    attempts.push(attempt);

    let header: CardSignatureProtectedHeader;
    try {
      header = decodeProtectedHeader(entry);
    } catch (err) {
      attempt.reason = err instanceof Error ? err.message : String(err);
      continue;
    }
    attempt.kid = header.kid;
    attempt.alg = header.alg;
    if (typeof header.jku === 'string') attempt.jku = header.jku;

    if (!isSigningAlgorithm(header.alg) || !algorithms.includes(header.alg)) {
      attempt.reason = `algorithm ${header.alg} is not accepted`;
      continue;
    }
    const alg = header.alg;

    // Gather every key that might verify this signature: trusted keys by kid,
    // the caller's resolver, then the jku under the fetch policy.
    const candidates: PublicKeyInput[] = candidateKeys(keyList(options.keys), header.kid);
    if (options.resolveKey) {
      try {
        const resolved = await options.resolveKey(header, { card });
        if (resolved) candidates.push(resolved);
      } catch (err) {
        attempt.reason = `key resolver failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (options.jwks && typeof header.jku === 'string') {
      if (!jkuAllowed(header.jku, options.jwks)) {
        attempt.reason = `jku ${header.jku} is not an allowed JWKS origin`;
      } else {
        try {
          let pending = jwksCache.get(header.jku);
          if (!pending) {
            pending = fetchJwks(header.jku, options.jwks);
            jwksCache.set(header.jku, pending);
          }
          const set = await pending;
          candidates.push(...candidateKeys(set.keys, header.kid));
        } catch (err) {
          attempt.reason = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (candidates.length === 0) {
      attempt.reason ??= `no trusted key for kid ${header.kid}`;
      continue;
    }

    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(entry.signature, 'base64url');
    } catch {
      attempt.reason = 'signature is not base64url';
      continue;
    }
    const input = signingInput(entry.protected, payload);

    let typeMismatch = 0;
    for (const candidate of candidates) {
      let publicKey: KeyObject;
      try {
        publicKey = toPublicKey(candidate);
      } catch {
        continue;
      }
      if (!keyMatchesAlgorithm(publicKey, alg)) {
        typeMismatch++;
        continue;
      }
      if (rawVerify(alg, input, publicKey, signatureBytes)) {
        attempt.ok = true;
        delete attempt.reason;
        return { index, kid: header.kid, alg, ...(attempt.jku ? { jku: attempt.jku } : {}), protectedHeader: header, attempts };
      }
    }
    attempt.reason =
      typeMismatch === candidates.length
        ? `no candidate key matches algorithm ${alg}`
        : 'signature does not verify against the trusted key';
  }

  const summary = attempts.map((a) => `#${a.index}${a.kid ? ` (kid ${a.kid})` : ''}: ${a.reason ?? 'failed'}`).join('; ');
  throw new AgentCardSignatureError('invalid_signatures', `no valid agent card signature (${summary})`, attempts);
}
