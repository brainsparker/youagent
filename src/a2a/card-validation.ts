/**
 * A2A Agent Card conformance validation.
 *
 * Judges a card against the revision of the A2A specification it is written
 * to (1.0, 0.3 or 0.2) rather than holding every card to the newest rules.
 * The two generations disagree on where the endpoint lives (top-level `url`
 * before 1.0, `supportedInterfaces` from 1.0) and on where the protocol
 * version lives (top-level before 1.0, per interface from 1.0), so a single
 * rule set would call correct 0.3 cards broken and miss real 1.0 mistakes.
 *
 * Every report says which revision it judged against, whether that revision
 * was declared by the card or inferred from its shape, and lists each
 * violation with the JSON path of the offending value. Documents that carry
 * none of the shape of an agent card come back as `not-an-agent-card` with
 * `valid: null` instead of a pile of missing-field errors.
 *
 * Only required fields and their types are checked. Security schemes are
 * checked structurally and signatures are never verified here; see
 * `signatures` warnings and the signing helpers for that.
 *
 * Spec: https://a2a-protocol.org/latest/specification/ (section 4.4)
 */

import { agentCardSchema } from '../schema/agent-card.schema.js';
import {
  A2A_CARD_MEDIA_TYPE,
  A2A_LEGACY_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
} from '../types/agent-card.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The specification revision a card is judged against. */
export type A2ACardRevision = '1.0' | '0.3' | '0.2';

/** How the judged revision was chosen. */
export type CardVersionSource = 'declared' | 'inferred' | 'none';

/** A problem found in the card. `error` fails validation, `warning` does not. */
export interface CardIssue {
  severity: 'error' | 'warning';
  /** Stable machine-readable code, e.g. `missing-field`, `wrong-type`. */
  code: string;
  /** JSON path of the offending value, e.g. `$.supportedInterfaces[0].url`. */
  path: string;
  message: string;
}

export interface CardValidationReport {
  /** `agent-card` when the document has the shape of a card at all. */
  kind: 'agent-card' | 'not-an-agent-card';
  /** Revision the card was judged against; null for non-cards. */
  judgedAgainst: A2ACardRevision | null;
  versionSource: CardVersionSource;
  /** One sentence explaining the revision choice. */
  whyThisVersion: string;
  /** Null when the document is not an agent card. */
  valid: boolean | null;
  errors: CardIssue[];
  warnings: CardIssue[];
  /** Quick facts pulled from the card for display, when present. */
  summary: {
    name?: string;
    version?: string;
    /** Endpoint URL per interface, in declared order. */
    endpoints: string[];
    skillCount: number;
    /** True when the card carries both `supportedInterfaces` and the legacy `url`. */
    transitional: boolean;
    hasYouAgentExtension: boolean;
    signed: boolean;
  };
}

/** Where a fetched card came from, for context warnings. */
export interface CardDocumentSource {
  /** Final URL the card was read from. */
  url: string;
  /** Well-known path that answered, or null when a direct URL was fetched. */
  path: string | null;
  /** HTTP status of the successful response. */
  status: number;
  /** Content-Type header value, lower-cased, without parameters. */
  contentType: string | null;
  /** Paths probed before one answered, each with its status (0 for a network error). */
  attempts: Array<{ url: string; status: number; error?: string }>;
}

export interface FetchCardDocumentOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Well-known paths to probe for a base URL, most current first. */
  paths?: readonly string[];
}

/** Thrown when a card document cannot be fetched or parsed as JSON. */
export class AgentCardFetchError extends Error {
  constructor(
    message: string,
    public readonly attempts: CardDocumentSource['attempts'],
  ) {
    super(message);
    this.name = 'AgentCardFetchError';
  }
}

export interface ValidateAgentCardOptions {
  /**
   * Transport context from `fetchAgentCardDocument`. Adds warnings about the
   * discovery path and media type the card was served with.
   */
  source?: CardDocumentSource;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

const isObject = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A2A protocol versions look like `1.0`, `0.3.0`, `0.2.5`. */
const PROTOCOL_VERSION_REGEX = /^\d+\.\d+(\.\d+)?$/;
/** MCP revisions are calendar dates; a few live cards put one here by mistake. */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_BINDINGS = new Set(['JSONRPC', 'GRPC', 'HTTP+JSON']);

/** Fields that exist on the 0.3 card but not on 0.2. */
const V03_ONLY_FIELDS = [
  'protocolVersion',
  'preferredTransport',
  'additionalInterfaces',
  'signatures',
  'supportsAuthenticatedExtendedCard',
] as const;

/** Fields shared by every card revision, used to tell cards from other JSON. */
const CARD_MARKER_FIELDS = [
  'name',
  'description',
  'version',
  'capabilities',
  'skills',
  'defaultInputModes',
  'defaultOutputModes',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

class IssueList {
  readonly errors: CardIssue[] = [];
  readonly warnings: CardIssue[] = [];

  error(code: string, path: string, message: string): void {
    this.errors.push({ severity: 'error', code, path, message });
  }

  warn(code: string, path: string, message: string): void {
    this.warnings.push({ severity: 'warning', code, path, message });
  }
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function requireString(issues: IssueList, obj: Dict, key: string, path: string): void {
  const value = obj[key];
  if (value === undefined) {
    issues.error('missing-field', `${path}.${key}`, `${key} is required`);
  } else if (typeof value !== 'string') {
    issues.error('wrong-type', `${path}.${key}`, `${key} must be a string, got ${describeType(value)}`);
  } else if (value.trim().length === 0) {
    issues.error('empty-value', `${path}.${key}`, `${key} must not be empty`);
  }
}

function requireStringArray(issues: IssueList, obj: Dict, key: string, path: string): void {
  const value = obj[key];
  if (value === undefined) {
    issues.error('missing-field', `${path}.${key}`, `${key} is required`);
  } else if (!isStringArray(value)) {
    issues.error('wrong-type', `${path}.${key}`, `${key} must be an array of strings, got ${describeType(value)}`);
  }
}

function checkAbsoluteUrl(issues: IssueList, value: string, path: string, allowHostPort: boolean): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    if (allowHostPort && /^[A-Za-z0-9.\-[\]:]+:\d{1,5}$/.test(value)) {
      return; // gRPC interfaces may use host:port
    }
    issues.error('invalid-url', path, `${value ? JSON.stringify(value) : 'empty string'} is not an absolute http(s) URL`);
    return;
  }
  if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)) {
    issues.warn('insecure-url', path, `${value} uses plain http; peers will send messages and credentials in the clear`);
  }
}

function checkProtocolVersion(issues: IssueList, value: unknown, path: string, expected: A2ACardRevision): void {
  if (typeof value !== 'string') return; // type errors reported elsewhere
  if (DATE_REGEX.test(value)) {
    issues.warn(
      'protocol-version-looks-like-mcp-date',
      path,
      `"${value}" is a calendar date, which is how MCP names revisions; A2A protocol versions look like "1.0" or "0.3.0"`,
    );
    return;
  }
  if (!PROTOCOL_VERSION_REGEX.test(value)) {
    issues.warn('protocol-version-unrecognized', path, `"${value}" does not look like an A2A protocol version (expected e.g. "1.0" or "0.3.0")`);
    return;
  }
  if (expected === '1.0' && !value.startsWith('1.')) {
    issues.warn(
      'protocol-version-mismatch',
      path,
      `interface speaks protocol ${value} inside a 1.0-structured card; allowed, but 1.0 clients may expect the 1.0 wire format here`,
    );
  }
}

function checkCapabilities(issues: IssueList, card: Dict, revision: A2ACardRevision): void {
  const caps = card['capabilities'];
  if (caps === undefined) {
    issues.error('missing-field', '$.capabilities', 'capabilities is required (an object, possibly empty)');
    return;
  }
  if (!isObject(caps)) {
    issues.error('wrong-type', '$.capabilities', `capabilities must be an object, got ${describeType(caps)}`);
    return;
  }
  for (const flag of ['streaming', 'pushNotifications', 'extendedAgentCard', 'stateTransitionHistory']) {
    const v = caps[flag];
    if (v !== undefined && typeof v !== 'boolean') {
      issues.error('wrong-type', `$.capabilities.${flag}`, `${flag} must be a boolean, got ${describeType(v)}`);
    }
  }
  if (revision === '1.0' && caps['stateTransitionHistory'] !== undefined) {
    issues.warn('deprecated-field', '$.capabilities.stateTransitionHistory', 'stateTransitionHistory was removed in A2A 1.0');
  }
  const ext = caps['extensions'];
  if (ext !== undefined) {
    if (!Array.isArray(ext)) {
      issues.error('wrong-type', '$.capabilities.extensions', `extensions must be an array, got ${describeType(ext)}`);
    } else {
      ext.forEach((e, i) => {
        const p = `$.capabilities.extensions[${i}]`;
        if (!isObject(e)) {
          issues.error('wrong-type', p, `extension must be an object, got ${describeType(e)}`);
        } else {
          requireString(issues, e, 'uri', p);
        }
      });
    }
  }
}

function checkSkills(issues: IssueList, card: Dict): void {
  const skills = card['skills'];
  if (skills === undefined) {
    issues.error('missing-field', '$.skills', 'skills is required (an array, possibly empty)');
    return;
  }
  if (!Array.isArray(skills)) {
    issues.error('wrong-type', '$.skills', `skills must be an array, got ${describeType(skills)}`);
    return;
  }
  if (skills.length === 0) {
    issues.warn('no-skills', '$.skills', 'the card declares no skills, so peers cannot tell what this agent does');
  }
  const seen = new Set<string>();
  skills.forEach((skill, i) => {
    const p = `$.skills[${i}]`;
    if (!isObject(skill)) {
      issues.error('wrong-type', p, `skill must be an object, got ${describeType(skill)}`);
      return;
    }
    requireString(issues, skill, 'id', p);
    requireString(issues, skill, 'name', p);
    requireString(issues, skill, 'description', p);
    requireStringArray(issues, skill, 'tags', p);
    for (const key of ['examples', 'inputModes', 'outputModes']) {
      const v = skill[key];
      if (v !== undefined && !isStringArray(v)) {
        issues.error('wrong-type', `${p}.${key}`, `${key} must be an array of strings, got ${describeType(v)}`);
      }
    }
    if (typeof skill['id'] === 'string') {
      if (seen.has(skill['id'])) {
        issues.error('duplicate-skill-id', `${p}.id`, `skill id "${skill['id']}" is declared more than once`);
      }
      seen.add(skill['id']);
    }
  });
}

function checkProvider(issues: IssueList, card: Dict, revision: A2ACardRevision): void {
  const provider = card['provider'];
  if (provider === undefined) return;
  if (!isObject(provider)) {
    issues.error('wrong-type', '$.provider', `provider must be an object, got ${describeType(provider)}`);
    return;
  }
  if (provider['organization'] === undefined && typeof provider['name'] === 'string') {
    // `name` was never in the spec at any revision, but some cards carry it.
    issues.error('renamed-field', '$.provider.name', 'provider.name is not an A2A field; use provider.organization');
  } else {
    requireString(issues, provider, 'organization', '$.provider');
  }
  requireString(issues, provider, 'url', '$.provider');
  void revision;
}

function checkSecurity(issues: IssueList, card: Dict, revision: A2ACardRevision): void {
  const schemes = card['securitySchemes'];
  if (schemes !== undefined && !isObject(schemes)) {
    issues.error('wrong-type', '$.securitySchemes', `securitySchemes must be an object keyed by scheme name, got ${describeType(schemes)}`);
  } else if (isObject(schemes)) {
    for (const [name, scheme] of Object.entries(schemes)) {
      if (!isObject(scheme)) {
        issues.error('wrong-type', `$.securitySchemes.${name}`, `security scheme must be an object, got ${describeType(scheme)}`);
      }
    }
  }

  const legacy = card['security'];
  const current = card['securityRequirements'];
  if (revision === '1.0') {
    if (legacy !== undefined && current === undefined) {
      issues.error('renamed-field', '$.security', 'security was renamed to securityRequirements in A2A 1.0');
    }
    if (current !== undefined && !Array.isArray(current)) {
      issues.error('wrong-type', '$.securityRequirements', `securityRequirements must be an array, got ${describeType(current)}`);
    }
  } else if (legacy !== undefined && !Array.isArray(legacy)) {
    issues.error('wrong-type', '$.security', `security must be an array, got ${describeType(legacy)}`);
  }

  const requirements = Array.isArray(current) ? current : Array.isArray(legacy) ? legacy : [];
  if (isObject(schemes) && requirements.length > 0) {
    const names = new Set(Object.keys(schemes));
    const key = Array.isArray(current) ? 'securityRequirements' : 'security';
    requirements.forEach((req, i) => {
      if (!isObject(req)) return;
      const named = isObject(req['schemes']) ? Object.keys(req['schemes']) : Object.keys(req);
      for (const n of named) {
        if (!names.has(n)) {
          issues.error('unknown-security-scheme', `$.${key}[${i}]`, `requirement references scheme "${n}", which securitySchemes does not define`);
        }
      }
    });
  }

  const signatures = card['signatures'];
  if (signatures !== undefined) {
    if (!Array.isArray(signatures)) {
      issues.error('wrong-type', '$.signatures', `signatures must be an array, got ${describeType(signatures)}`);
    } else {
      signatures.forEach((sig, i) => {
        const p = `$.signatures[${i}]`;
        if (!isObject(sig)) {
          issues.error('wrong-type', p, `signature must be an object, got ${describeType(sig)}`);
          return;
        }
        requireString(issues, sig, 'protected', p);
        requireString(issues, sig, 'signature', p);
      });
      if (signatures.length > 0) {
        issues.warn('signatures-not-verified', '$.signatures', 'the card is signed; this check reads the structure only and does not verify the signatures');
      }
    }
  }
}

function checkCommonFields(issues: IssueList, card: Dict): void {
  requireString(issues, card, 'name', '$');
  requireString(issues, card, 'description', '$');
  requireString(issues, card, 'version', '$');
  requireStringArray(issues, card, 'defaultInputModes', '$');
  requireStringArray(issues, card, 'defaultOutputModes', '$');
  for (const key of ['documentationUrl', 'iconUrl']) {
    const v = card[key];
    if (v !== undefined) {
      if (typeof v !== 'string') {
        issues.error('wrong-type', `$.${key}`, `${key} must be a string, got ${describeType(v)}`);
      } else {
        checkAbsoluteUrl(issues, v, `$.${key}`, false);
      }
    }
  }
}

function checkInterfacesV1(issues: IssueList, card: Dict): string[] {
  const endpoints: string[] = [];
  const interfaces = card['supportedInterfaces'];
  if (interfaces === undefined) {
    issues.error('missing-field', '$.supportedInterfaces', 'supportedInterfaces is required in A2A 1.0 (the top-level url was removed)');
    return endpoints;
  }
  if (!Array.isArray(interfaces)) {
    issues.error('wrong-type', '$.supportedInterfaces', `supportedInterfaces must be an array, got ${describeType(interfaces)}`);
    return endpoints;
  }
  if (interfaces.length === 0) {
    issues.error('empty-value', '$.supportedInterfaces', 'supportedInterfaces must list at least one interface');
    return endpoints;
  }
  interfaces.forEach((iface, i) => {
    const p = `$.supportedInterfaces[${i}]`;
    if (!isObject(iface)) {
      issues.error('wrong-type', p, `interface must be an object, got ${describeType(iface)}`);
      return;
    }
    requireString(issues, iface, 'url', p);
    if (iface['protocolBinding'] === undefined && typeof iface['transport'] === 'string') {
      issues.error('renamed-field', `${p}.transport`, 'transport was renamed to protocolBinding in A2A 1.0');
    } else {
      requireString(issues, iface, 'protocolBinding', p);
    }
    requireString(issues, iface, 'protocolVersion', p);
    checkProtocolVersion(issues, iface['protocolVersion'], `${p}.protocolVersion`, '1.0');
    const binding = iface['protocolBinding'];
    if (isNonEmptyString(binding) && !KNOWN_BINDINGS.has(binding) && !/^[a-z][a-z0-9+.-]*:/i.test(binding)) {
      issues.warn('unknown-binding', `${p}.protocolBinding`, `"${binding}" is not JSONRPC, GRPC or HTTP+JSON and is not a URI; clients that do not know it will skip this interface`);
    }
    if (isNonEmptyString(iface['url'])) {
      checkAbsoluteUrl(issues, iface['url'], `${p}.url`, binding === 'GRPC');
      endpoints.push(iface['url']);
    }
  });

  // Transitional cards keep the legacy url; it must point where the preferred interface points.
  const legacyUrl = card['url'];
  if (typeof legacyUrl === 'string' && endpoints.length > 0 && legacyUrl !== endpoints[0]) {
    issues.warn('endpoint-mismatch', '$.url', `legacy url "${legacyUrl}" differs from the preferred interface "${endpoints[0]}"; pre-1.0 and 1.0 clients will reach different endpoints`);
  }
  if (card['protocolVersion'] !== undefined && typeof card['protocolVersion'] !== 'string') {
    issues.error('wrong-type', '$.protocolVersion', `protocolVersion must be a string, got ${describeType(card['protocolVersion'])}`);
  }
  for (const key of ['preferredTransport', 'additionalInterfaces']) {
    if (card[key] !== undefined) {
      issues.warn('deprecated-field', `$.${key}`, `${key} was folded into supportedInterfaces in A2A 1.0 and is ignored by 1.0 clients`);
    }
  }
  if (card['supportsAuthenticatedExtendedCard'] !== undefined) {
    issues.warn('deprecated-field', '$.supportsAuthenticatedExtendedCard', 'supportsAuthenticatedExtendedCard moved to capabilities.extendedAgentCard in A2A 1.0');
  }
  return endpoints;
}

function checkInterfacesLegacy(issues: IssueList, card: Dict, revision: '0.3' | '0.2'): string[] {
  const endpoints: string[] = [];
  const url = card['url'];
  if (url === undefined) {
    issues.error('missing-field', '$.url', `url is required in A2A ${revision}`);
  } else if (typeof url !== 'string') {
    issues.error('wrong-type', '$.url', `url must be a string, got ${describeType(url)}`);
  } else if (url.trim().length === 0) {
    issues.error('empty-value', '$.url', 'url must not be empty');
  } else {
    checkAbsoluteUrl(issues, url, '$.url', false);
    endpoints.push(url);
  }

  if (revision === '0.3') {
    requireString(issues, card, 'protocolVersion', '$');
    checkProtocolVersion(issues, card['protocolVersion'], '$.protocolVersion', '0.3');
    const preferred = card['preferredTransport'];
    if (preferred !== undefined && typeof preferred !== 'string') {
      issues.error('wrong-type', '$.preferredTransport', `preferredTransport must be a string, got ${describeType(preferred)}`);
    }
    const additional = card['additionalInterfaces'];
    if (additional !== undefined) {
      if (!Array.isArray(additional)) {
        issues.error('wrong-type', '$.additionalInterfaces', `additionalInterfaces must be an array, got ${describeType(additional)}`);
      } else {
        additional.forEach((iface, i) => {
          const p = `$.additionalInterfaces[${i}]`;
          if (!isObject(iface)) {
            issues.error('wrong-type', p, `interface must be an object, got ${describeType(iface)}`);
            return;
          }
          requireString(issues, iface, 'url', p);
          requireString(issues, iface, 'transport', p);
          if (isNonEmptyString(iface['url'])) {
            checkAbsoluteUrl(issues, iface['url'], `${p}.url`, iface['transport'] === 'GRPC');
            endpoints.push(iface['url']);
          }
        });
      }
    }
    const extended = card['supportsAuthenticatedExtendedCard'];
    if (extended !== undefined && typeof extended !== 'boolean') {
      issues.error('wrong-type', '$.supportsAuthenticatedExtendedCard', `supportsAuthenticatedExtendedCard must be a boolean, got ${describeType(extended)}`);
    }
  } else if (card['protocolVersion'] !== undefined && typeof card['protocolVersion'] !== 'string') {
    issues.error('wrong-type', '$.protocolVersion', `protocolVersion must be a string, got ${describeType(card['protocolVersion'])}`);
  }
  return endpoints;
}

/** Validate the optional `youagent` extension block with the package schema. */
function checkYouAgentExtension(issues: IssueList, card: Dict): void {
  if (card['youagent'] === undefined) return;
  if (!isObject(card['youagent'])) {
    issues.error('wrong-type', '$.youagent', `youagent must be an object, got ${describeType(card['youagent'])}`);
    return;
  }
  const result = agentCardSchema.safeParse(card);
  if (result.success) return;
  for (const issue of result.error.issues) {
    if (issue.path[0] !== 'youagent') continue; // A2A fields are covered by the revision checks above
    const path = '$' + issue.path.map((seg) => (typeof seg === 'number' ? `[${seg}]` : `.${String(seg)}`)).join('');
    issues.error('youagent-extension', path, issue.message);
  }
}

// ---------------------------------------------------------------------------
// Revision detection
// ---------------------------------------------------------------------------

interface RevisionChoice {
  revision: A2ACardRevision | null;
  source: CardVersionSource;
  why: string;
}

/**
 * Decide which revision to judge a card against.
 *
 * Declared beats inferred: a `1.x` protocol version on any interface or a
 * `0.x` top-level `protocolVersion` names the revision outright. Otherwise
 * the shape decides: `supportedInterfaces` means 1.0, a top-level `url` with
 * 0.3-only fields means 0.3, and a bare top-level `url` means 0.2 (the last
 * revision that did not require a protocol version, so the card is not
 * faulted for a field it never claimed).
 */
export function detectCardRevision(card: Dict): RevisionChoice {
  const interfaces = Array.isArray(card['supportedInterfaces']) ? (card['supportedInterfaces'] as unknown[]) : undefined;
  const topVersion = typeof card['protocolVersion'] === 'string' ? (card['protocolVersion'] as string) : undefined;
  const hasUrl = typeof card['url'] === 'string';

  if (interfaces) {
    const versions = interfaces
      .map((i) => (isObject(i) && typeof i['protocolVersion'] === 'string' ? (i['protocolVersion'] as string) : undefined))
      .filter((v): v is string => v !== undefined);
    const declared = versions.find((v) => v.startsWith('1.'));
    if (declared) {
      return { revision: '1.0', source: 'declared', why: `an entry of supportedInterfaces declares protocolVersion "${declared}"` };
    }
    const note = hasUrl ? ' (the card is transitional: it also carries the legacy top-level url)' : '';
    return {
      revision: '1.0',
      source: 'inferred',
      why: `the card carries supportedInterfaces, which only exists from A2A 1.0${note}`,
    };
  }

  if (topVersion !== undefined) {
    if (topVersion.startsWith('1.')) {
      return {
        revision: '1.0',
        source: 'declared',
        why: `the top-level protocolVersion is "${topVersion}", so the card claims A2A 1.0 even though it lacks supportedInterfaces`,
      };
    }
    if (topVersion.startsWith('0.3')) {
      return { revision: '0.3', source: 'declared', why: `the top-level protocolVersion is "${topVersion}"` };
    }
    if (topVersion.startsWith('0.2') || topVersion.startsWith('0.1')) {
      return { revision: '0.2', source: 'declared', why: `the top-level protocolVersion is "${topVersion}"` };
    }
    return {
      revision: '0.3',
      source: 'inferred',
      why: `the top-level protocolVersion "${topVersion}" is not a recognized A2A version; a top-level protocolVersion field first appeared in 0.3`,
    };
  }

  if (hasUrl) {
    const v03Markers = V03_ONLY_FIELDS.filter((f) => f !== 'protocolVersion' && card[f] !== undefined);
    if (v03Markers.length > 0) {
      return {
        revision: '0.3',
        source: 'inferred',
        why: `the card has a top-level url and the 0.3 field${v03Markers.length > 1 ? 's' : ''} ${v03Markers.join(', ')}`,
      };
    }
    return {
      revision: '0.2',
      source: 'inferred',
      why: 'the card has a top-level url and names no protocol version; 0.2 is the last revision that did not require one',
    };
  }

  const markers = CARD_MARKER_FIELDS.filter((f) => card[f] !== undefined);
  if (markers.length >= 3) {
    return {
      revision: '1.0',
      source: 'inferred',
      why: `the document has agent-card fields (${markers.join(', ')}) but no endpoint at all; judged against 1.0 by elimination`,
    };
  }
  return { revision: null, source: 'none', why: 'nothing in the document claims to be an A2A agent card (no url, no supportedInterfaces, no protocolVersion, and fewer than three card fields)' };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function checkSource(issues: IssueList, source: CardDocumentSource, revision: A2ACardRevision | null): void {
  if (source.path === A2A_LEGACY_WELL_KNOWN_PATH) {
    const missed = source.attempts.find((a) => a.url.endsWith(A2A_WELL_KNOWN_PATH));
    issues.warn(
      'legacy-discovery-path',
      '$',
      `the card was only found at ${A2A_LEGACY_WELL_KNOWN_PATH}; A2A 1.0 clients look at ${A2A_WELL_KNOWN_PATH} first` +
        (missed ? ` (that path answered ${missed.status === 0 ? `with an error: ${missed.error ?? 'unknown'}` : `HTTP ${missed.status}`})` : ''),
    );
  }
  if (revision === '1.0' && source.path === A2A_WELL_KNOWN_PATH && source.contentType && source.contentType !== A2A_CARD_MEDIA_TYPE) {
    issues.warn('media-type', '$', `served as ${source.contentType}; A2A 1.0 registers ${A2A_CARD_MEDIA_TYPE} for agent cards`);
  }
}

/**
 * Validate a parsed agent card document against the A2A revision it is
 * written to. Never throws on bad input: non-object documents come back as
 * `not-an-agent-card`.
 */
export function validateAgentCard(raw: unknown, options: ValidateAgentCardOptions = {}): CardValidationReport {
  const issues = new IssueList();
  const empty: CardValidationReport['summary'] = {
    endpoints: [],
    skillCount: 0,
    transitional: false,
    hasYouAgentExtension: false,
    signed: false,
  };

  if (!isObject(raw)) {
    return {
      kind: 'not-an-agent-card',
      judgedAgainst: null,
      versionSource: 'none',
      whyThisVersion: `the document is ${describeType(raw)}, not a JSON object`,
      valid: null,
      errors: [],
      warnings: [],
      summary: empty,
    };
  }

  const choice = detectCardRevision(raw);
  if (choice.revision === null) {
    return {
      kind: 'not-an-agent-card',
      judgedAgainst: null,
      versionSource: 'none',
      whyThisVersion: choice.why,
      valid: null,
      errors: [],
      warnings: [],
      summary: empty,
    };
  }

  const revision = choice.revision;
  checkCommonFields(issues, raw);
  const endpoints = revision === '1.0' ? checkInterfacesV1(issues, raw) : checkInterfacesLegacy(issues, raw, revision);
  checkCapabilities(issues, raw, revision);
  checkSkills(issues, raw);
  checkProvider(issues, raw, revision);
  checkSecurity(issues, raw, revision);
  checkYouAgentExtension(issues, raw);
  if (options.source) {
    checkSource(issues, options.source, revision);
  }

  const skills = Array.isArray(raw['skills']) ? raw['skills'] : [];
  const signatures = Array.isArray(raw['signatures']) ? raw['signatures'] : [];
  return {
    kind: 'agent-card',
    judgedAgainst: revision,
    versionSource: choice.source,
    whyThisVersion: choice.why,
    valid: issues.errors.length === 0,
    errors: issues.errors,
    warnings: issues.warnings,
    summary: {
      name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
      version: typeof raw['version'] === 'string' ? raw['version'] : undefined,
      endpoints,
      skillCount: skills.length,
      transitional: Array.isArray(raw['supportedInterfaces']) && typeof raw['url'] === 'string',
      hasYouAgentExtension: raw['youagent'] !== undefined,
      signed: signatures.length > 0,
    },
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch a card document for validation, keeping the transport facts that
 * `fetchAgentCard` discards: which well-known path answered, the HTTP
 * status, and the media type.
 *
 * A URL whose path ends in `.json` is fetched as-is. Any other URL is treated
 * as an agent base URL and the well-known paths are probed in order, most
 * current first. The body is returned unparsed by any schema so the
 * validator sees exactly what the server published.
 *
 * @throws AgentCardFetchError when no probe returns a 2xx JSON body.
 */
export async function fetchAgentCardDocument(
  target: string,
  options: FetchCardDocumentOptions = {},
): Promise<{ document: unknown; source: CardDocumentSource }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const paths = options.paths ?? [A2A_WELL_KNOWN_PATH, A2A_LEGACY_WELL_KNOWN_PATH];

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(target);
  } catch {
    throw new AgentCardFetchError(`"${target}" is not an absolute URL`, []);
  }
  if (!/^https?:$/.test(parsedTarget.protocol)) {
    throw new AgentCardFetchError(`"${target}" must use http or https`, []);
  }

  const direct = /\.json$/i.test(parsedTarget.pathname);
  const base = `${parsedTarget.origin}${parsedTarget.pathname.replace(/\/+$/, '')}`;
  const candidates: Array<{ url: string; path: string | null }> = direct
    ? [{ url: parsedTarget.toString(), path: null }]
    : paths.map((p) => ({ url: `${base}${p}`, path: p }));

  const attempts: CardDocumentSource['attempts'] = [];
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(candidate.url, {
        method: 'GET',
        headers: { Accept: `${A2A_CARD_MEDIA_TYPE}, application/json;q=0.9` },
        signal: controller.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      if (!res.ok) {
        attempts.push({ url: candidate.url, status: res.status, error: text.slice(0, 200) || undefined });
        continue;
      }
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch (err) {
        attempts.push({ url: candidate.url, status: res.status, error: `body is not JSON: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const rawType = res.headers.get('content-type');
      const contentType = rawType ? rawType.split(';')[0].trim().toLowerCase() : null;
      return {
        document,
        source: {
          url: res.url || candidate.url,
          path: candidate.path,
          status: res.status,
          contentType,
          attempts: [...attempts],
        },
      };
    } catch (err) {
      const message = err instanceof Error ? (err.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : err.message) : String(err);
      attempts.push({ url: candidate.url, status: 0, error: message });
    } finally {
      clearTimeout(timer);
    }
  }

  const summary = attempts
    .map((a) => `${a.url} -> ${a.status === 0 ? `error: ${a.error ?? 'unknown'}` : `HTTP ${a.status}`}`)
    .join('; ');
  throw new AgentCardFetchError(`No agent card found for ${target} (${summary})`, attempts);
}
