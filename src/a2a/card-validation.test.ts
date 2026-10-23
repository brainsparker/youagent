import { describe, expect, it, vi } from 'vitest';
import {
  AgentCardFetchError,
  detectCardRevision,
  fetchAgentCardDocument,
  validateAgentCard,
} from './card-validation.js';
import { createAgentCard, createExternalAgentCard } from '../schema/agent-card.schema.js';
import { toV1AgentCard } from '../types/agent-card.js';

const V1_CARD = {
  name: 'Modern Agent',
  description: 'Already on 1.0',
  version: '2.0.0',
  supportedInterfaces: [
    { url: 'https://modern.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  skills: [{ id: 'search', name: 'Search', description: 'Searches', tags: ['search'] }],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const V03_CARD = {
  name: 'Legacy Agent',
  description: 'On the 0.3 shape',
  version: '1.4.0',
  url: 'https://legacy.test/a2a',
  protocolVersion: '0.3.0',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: false },
  skills: [{ id: 'answer', name: 'Answer', description: 'Answers', tags: ['qa'] }],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const V02_CARD = {
  name: 'Old Agent',
  description: 'Pre-0.3, never had a protocolVersion field',
  version: '0.9.0',
  url: 'https://old.test/a2a',
  capabilities: {},
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);
const paths = (issues: Array<{ path: string }>) => issues.map((i) => i.path);

describe('detectCardRevision', () => {
  it('reads a declared 1.0 from an interface protocolVersion', () => {
    expect(detectCardRevision(V1_CARD)).toMatchObject({ revision: '1.0', source: 'declared' });
  });

  it('infers 1.0 from supportedInterfaces when no interface names a 1.x version', () => {
    const card = { ...V1_CARD, supportedInterfaces: [{ url: 'https://x.test', protocolBinding: 'JSONRPC', protocolVersion: '0.2.1' }] };
    expect(detectCardRevision(card)).toMatchObject({ revision: '1.0', source: 'inferred' });
  });

  it('reads a declared 0.3 and 0.2 from the top-level protocolVersion', () => {
    expect(detectCardRevision(V03_CARD)).toMatchObject({ revision: '0.3', source: 'declared' });
    expect(detectCardRevision({ ...V02_CARD, protocolVersion: '0.2.5' })).toMatchObject({ revision: '0.2', source: 'declared' });
  });

  it('infers 0.3 from 0.3-only fields and 0.2 from a bare top-level url', () => {
    const { protocolVersion: _v, ...noVersion } = V03_CARD;
    expect(detectCardRevision(noVersion)).toMatchObject({ revision: '0.3', source: 'inferred' });
    expect(detectCardRevision(noVersion).why).toContain('preferredTransport');
    expect(detectCardRevision(V02_CARD)).toMatchObject({ revision: '0.2', source: 'inferred' });
  });

  it('returns none for documents with no card shape', () => {
    expect(detectCardRevision({ hello: 'world' })).toMatchObject({ revision: null, source: 'none' });
    expect(detectCardRevision({ name: 'x', description: 'y' })).toMatchObject({ revision: null });
  });

  it('judges an endpoint-less document with card fields against 1.0 by elimination', () => {
    const { supportedInterfaces: _i, ...noEndpoint } = V1_CARD;
    expect(detectCardRevision(noEndpoint)).toMatchObject({ revision: '1.0', source: 'inferred' });
  });
});

describe('validateAgentCard', () => {
  it('passes a correct 1.0 card with no warnings', () => {
    const report = validateAgentCard(V1_CARD);
    expect(report).toMatchObject({ kind: 'agent-card', judgedAgainst: '1.0', versionSource: 'declared', valid: true });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toMatchObject({ name: 'Modern Agent', endpoints: ['https://modern.test/a2a'], skillCount: 1, transitional: false });
  });

  it('passes a correct 0.3 card judged by its own rules', () => {
    const report = validateAgentCard(V03_CARD);
    expect(report).toMatchObject({ judgedAgainst: '0.3', valid: true });
    expect(report.errors).toEqual([]);
  });

  it('does not fault a versionless 0.2-shaped card for a protocolVersion it never claimed', () => {
    const report = validateAgentCard(V02_CARD);
    expect(report).toMatchObject({ judgedAgainst: '0.2', versionSource: 'inferred', valid: true });
    expect(codes(report.warnings)).toEqual(['no-skills']);
  });

  it('requires protocolVersion once a card uses other 0.3 fields', () => {
    const { protocolVersion: _v, ...card } = V03_CARD;
    const report = validateAgentCard(card);
    expect(report).toMatchObject({ judgedAgainst: '0.3', versionSource: 'inferred', valid: false });
    expect(report.errors).toEqual([
      { severity: 'error', code: 'missing-field', path: '$.protocolVersion', message: 'protocolVersion is required' },
    ]);
  });

  it('reports every missing required 1.0 field with its JSON path', () => {
    const report = validateAgentCard({ supportedInterfaces: [{ url: 'https://x.test' }] });
    expect(report.valid).toBe(false);
    expect(paths(report.errors)).toEqual([
      '$.name',
      '$.description',
      '$.version',
      '$.defaultInputModes',
      '$.defaultOutputModes',
      '$.supportedInterfaces[0].protocolBinding',
      '$.supportedInterfaces[0].protocolVersion',
      '$.capabilities',
      '$.skills',
    ]);
  });

  it('flags a 1.0-structured card that has no supportedInterfaces', () => {
    const { supportedInterfaces: _i, ...card } = V1_CARD;
    const report = validateAgentCard(card);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'missing-field', path: '$.supportedInterfaces' }),
    ]);
  });

  it('flags pre-1.0 names used inside 1.0 structures as renamed fields', () => {
    const card = {
      ...V1_CARD,
      supportedInterfaces: [{ url: 'https://x.test/a2a', transport: 'JSONRPC', protocolVersion: '1.0' }],
      provider: { name: 'Acme', url: 'https://acme.test' },
      security: [{ bearer: [] }],
    };
    const report = validateAgentCard(card);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'renamed-field', path: '$.supportedInterfaces[0].transport' }),
      expect.objectContaining({ code: 'renamed-field', path: '$.provider.name' }),
      expect.objectContaining({ code: 'renamed-field', path: '$.security' }),
    ]);
  });

  it('warns when an interface protocolVersion is an MCP-style release date', () => {
    const card = {
      ...V1_CARD,
      supportedInterfaces: [{ url: 'https://x.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '2025-06-18' }],
    };
    const report = validateAgentCard(card);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([
      expect.objectContaining({ code: 'protocol-version-looks-like-mcp-date', path: '$.supportedInterfaces[0].protocolVersion' }),
    ]);
  });

  it('checks types, not just presence', () => {
    const card = {
      ...V1_CARD,
      name: 42,
      defaultInputModes: 'text/plain',
      capabilities: { streaming: 'yes' },
      skills: [{ id: 'a', name: 'A', description: 'd', tags: 'nope' }],
    };
    const report = validateAgentCard(card);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'wrong-type', path: '$.name' }),
      expect.objectContaining({ code: 'wrong-type', path: '$.defaultInputModes' }),
      expect.objectContaining({ code: 'wrong-type', path: '$.capabilities.streaming' }),
      expect.objectContaining({ code: 'wrong-type', path: '$.skills[0].tags' }),
    ]);
  });

  it('rejects invalid endpoint URLs but allows host:port for gRPC', () => {
    const card = {
      ...V1_CARD,
      supportedInterfaces: [
        { url: 'not a url', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: 'grpc.test:443', protocolBinding: 'GRPC', protocolVersion: '1.0' },
      ],
    };
    const report = validateAgentCard(card);
    expect(report.errors).toEqual([expect.objectContaining({ code: 'invalid-url', path: '$.supportedInterfaces[0].url' })]);
    expect(report.summary.endpoints).toEqual(['not a url', 'grpc.test:443']);
  });

  it('warns about plain http endpoints that are not local', () => {
    const remote = validateAgentCard({ ...V03_CARD, url: 'http://peer.test/a2a' });
    expect(codes(remote.warnings)).toContain('insecure-url');
    const local = validateAgentCard({ ...V03_CARD, url: 'http://localhost:3141' });
    expect(codes(local.warnings)).not.toContain('insecure-url');
  });

  it('flags duplicate skill ids and requirements that name undefined schemes', () => {
    const card = {
      ...V1_CARD,
      skills: [
        { id: 'search', name: 'Search', description: 'a', tags: [] },
        { id: 'search', name: 'Search again', description: 'b', tags: [] },
      ],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
      securityRequirements: [{ schemes: { oauth: { list: [] } } }],
    };
    const report = validateAgentCard(card);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'duplicate-skill-id', path: '$.skills[1].id' }),
      expect.objectContaining({ code: 'unknown-security-scheme', path: '$.securityRequirements[0]' }),
    ]);
  });

  it('accepts the transitional cards this package emits and notes the shape', () => {
    const card = createAgentCard({
      handle: 'climate-watch',
      interests: [{ topic: 'carbon capture' }],
      cadence: '6h',
      url: 'https://climate.test/a2a',
    });
    const report = validateAgentCard(card);
    expect(report).toMatchObject({ judgedAgainst: '1.0', versionSource: 'inferred', valid: true });
    expect(report.summary).toMatchObject({ transitional: true, hasYouAgentExtension: true, skillCount: 2 });
    expect(report.whyThisVersion).toContain('transitional');
    // The interface honestly declares the 0.2.1 wire format it speaks; that is a warning, not a violation.
    expect(codes(report.warnings)).toEqual(['protocol-version-mismatch']);

    const strict = validateAgentCard(toV1AgentCard(card));
    expect(strict.valid).toBe(true);
    expect(strict.summary.transitional).toBe(false);
  });

  it('warns when the legacy url points somewhere other than the preferred interface', () => {
    const card = createExternalAgentCard({ name: 'Peer', url: 'https://peer.test/a2a' });
    const report = validateAgentCard({ ...card, url: 'https://elsewhere.test/a2a' });
    expect(report.valid).toBe(true);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'endpoint-mismatch', path: '$.url' }));
  });

  it('validates the youagent extension block with the package schema', () => {
    const card = createAgentCard({ handle: 'climate-watch', interests: [{ topic: 'x' }], cadence: '6h' });
    const report = validateAgentCard({ ...card, youagent: { ...card.youagent, handle: 'Bad Handle!', cadence: 'whenever' } });
    expect(report.valid).toBe(false);
    expect(paths(report.errors)).toEqual(['$.youagent.handle', '$.youagent.cadence']);
    expect(report.errors.every((e) => e.code === 'youagent-extension')).toBe(true);
  });

  it('warns on deprecated 0.3 fields carried into a 1.0 card and on unverified signatures', () => {
    const card = {
      ...V1_CARD,
      capabilities: { streaming: false, stateTransitionHistory: true },
      supportsAuthenticatedExtendedCard: true,
      signatures: [{ protected: 'eyJ', signature: 'abc' }],
    };
    const report = validateAgentCard(card);
    expect(report.valid).toBe(true);
    expect(codes(report.warnings).sort()).toEqual(['deprecated-field', 'deprecated-field', 'signatures-not-verified']);
    expect(report.summary.signed).toBe(true);
  });

  it('returns not-an-agent-card for non-objects and shapeless documents', () => {
    for (const doc of [null, 'text', 42, [], { hello: 'world' }]) {
      const report = validateAgentCard(doc);
      expect(report).toMatchObject({ kind: 'not-an-agent-card', judgedAgainst: null, versionSource: 'none', valid: null });
      expect(report.errors).toEqual([]);
    }
  });

  it('adds discovery-path and media-type warnings from the fetch source', () => {
    const legacyOnly = validateAgentCard(V03_CARD, {
      source: {
        url: 'https://legacy.test/.well-known/agent.json',
        path: '/.well-known/agent.json',
        status: 200,
        contentType: 'application/json',
        attempts: [{ url: 'https://legacy.test/.well-known/agent-card.json', status: 404 }],
      },
    });
    expect(legacyOnly.warnings).toEqual([expect.objectContaining({ code: 'legacy-discovery-path' })]);
    expect(legacyOnly.warnings[0].message).toContain('HTTP 404');

    const wrongType = validateAgentCard(V1_CARD, {
      source: { url: 'https://modern.test/.well-known/agent-card.json', path: '/.well-known/agent-card.json', status: 200, contentType: 'application/json', attempts: [] },
    });
    expect(wrongType.warnings).toEqual([expect.objectContaining({ code: 'media-type' })]);

    const right = validateAgentCard(V1_CARD, {
      source: { url: 'https://modern.test/.well-known/agent-card.json', path: '/.well-known/agent-card.json', status: 200, contentType: 'application/a2a+json', attempts: [] },
    });
    expect(right.warnings).toEqual([]);
  });
});

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const asFetch = (mock: FetchMock): typeof fetch => mock as unknown as typeof fetch;
const jsonResponse = (body: unknown, status = 200, contentType = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });

describe('fetchAgentCardDocument', () => {
  it('probes the 1.0 well-known path first and records the media type', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse(V1_CARD, 200, 'application/a2a+json; charset=utf-8'));
    const { document, source } = await fetchAgentCardDocument('https://modern.test/', { fetchImpl: asFetch(fetchMock) });
    expect(fetchMock.mock.calls[0][0]).toBe('https://modern.test/.well-known/agent-card.json');
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['Accept']).toContain('application/a2a+json');
    expect(document).toEqual(V1_CARD);
    expect(source).toMatchObject({ path: '/.well-known/agent-card.json', status: 200, contentType: 'application/a2a+json', attempts: [] });
  });

  it('falls back to the legacy path and keeps the failed attempt', async () => {
    const fetchMock: FetchMock = vi.fn(async (url: string) =>
      url.endsWith('/agent-card.json') ? new Response('nope', { status: 404 }) : jsonResponse(V03_CARD),
    );
    const { source } = await fetchAgentCardDocument('https://legacy.test', { fetchImpl: asFetch(fetchMock) });
    expect(source.path).toBe('/.well-known/agent.json');
    expect(source.attempts).toEqual([{ url: 'https://legacy.test/.well-known/agent-card.json', status: 404, error: 'nope' }]);
  });

  it('fetches a direct .json URL without probing', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse(V1_CARD));
    const { source } = await fetchAgentCardDocument('https://modern.test/cards/agent.json', { fetchImpl: asFetch(fetchMock) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://modern.test/cards/agent.json');
    expect(source.path).toBeNull();
  });

  it('does not treat a non-JSON 200 as a card', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse('<html>hi</html>', 200, 'text/html'));
    const err = await fetchAgentCardDocument('https://html.test', { fetchImpl: asFetch(fetchMock) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCardFetchError);
    expect((err as AgentCardFetchError).attempts).toHaveLength(2);
    expect((err as AgentCardFetchError).attempts[0].error).toContain('not JSON');
  });

  it('rejects non-http targets up front', async () => {
    await expect(fetchAgentCardDocument('ftp://x.test')).rejects.toBeInstanceOf(AgentCardFetchError);
    await expect(fetchAgentCardDocument('not a url')).rejects.toBeInstanceOf(AgentCardFetchError);
  });
});
