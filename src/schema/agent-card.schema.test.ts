import { describe, it, expect } from 'vitest';
import { agentCardSchema, createAgentCard, createExternalAgentCard } from './agent-card.schema.js';
import {
  getAgentIdentifier,
  getAgentUrl,
  getPrimaryInterface,
  normalizeAgentCard,
  toProtocolBinding,
  toV1AgentCard,
} from '../types/agent-card.js';

const VALID_CARD = {
  name: 'Climate Agent',
  description: 'Tracks climate tech news.',
  url: 'https://climate.example.com',
  skills: [
    {
      id: 'search',
      name: 'Search',
      description: 'Searches the web',
      tags: ['climate', 'search'],
    },
  ],
};

describe('agentCardSchema', () => {
  it('accepts a minimal valid card and applies defaults', () => {
    const card = agentCardSchema.parse(VALID_CARD);
    expect(card.version).toBe('0.1.0');
    expect(card.capabilities.streaming).toBe(false);
    expect(card.defaultInputModes).toEqual(['text/plain']);
  });

  it('rejects a card without a name', () => {
    const { name: _name, ...rest } = VALID_CARD;
    expect(agentCardSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a card with an invalid url', () => {
    expect(agentCardSchema.safeParse({ ...VALID_CARD, url: 'not-a-url' }).success).toBe(false);
  });

  it('rejects skills missing required fields', () => {
    const bad = { ...VALID_CARD, skills: [{ id: 'x' }] };
    expect(agentCardSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts youagent extensions', () => {
    const card = agentCardSchema.parse({
      ...VALID_CARD,
      youagent: {
        handle: 'climate-agent',
        cadence: '6h',
        interests: [{ topic: 'climate tech' }],
      },
    });
    expect(card.youagent?.handle).toBe('climate-agent');
  });
});

describe('agentCardSchema (A2A v1.0 structure)', () => {
  it('upgrades a pre-1.0 card: supportedInterfaces is synthesized from url and protocolVersion', () => {
    const card = agentCardSchema.parse({ ...VALID_CARD, protocolVersion: '0.2.1' });

    expect(card.supportedInterfaces).toEqual([
      { url: 'https://climate.example.com', protocolBinding: 'JSONRPC', protocolVersion: '0.2.1' },
    ]);
    // Transitional: legacy fields are preserved for pre-1.0 readers.
    expect(card.url).toBe('https://climate.example.com');
    expect(card.protocolVersion).toBe('0.2.1');
  });

  it('defaults the synthesized interface protocolVersion when the legacy card has none', () => {
    const card = agentCardSchema.parse(VALID_CARD);
    expect(card.supportedInterfaces[0].protocolVersion).toBe('0.2.1');
    expect(card.protocolVersion).toBeUndefined();
  });

  it('accepts a strict v1.0 card without a top-level url and fills url from the preferred interface', () => {
    const { url: _url, ...v1 } = VALID_CARD;
    const card = agentCardSchema.parse({
      ...v1,
      version: '3.1.0',
      supportedInterfaces: [
        { url: 'https://agents.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: 'grpc.example.com:443', protocolBinding: 'GRPC', protocolVersion: '1.0' },
      ],
    });

    expect(card.supportedInterfaces).toHaveLength(2);
    expect(card.url).toBe('https://agents.example.com/a2a');
    expect(card.version).toBe('3.1.0');
  });

  it('rejects a card that declares neither supportedInterfaces nor a legacy url', () => {
    const { url: _url, ...rest } = VALID_CARD;
    const result = agentCardSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects an interface entry that is missing protocolBinding', () => {
    const result = agentCardSchema.safeParse({
      ...VALID_CARD,
      supportedInterfaces: [{ url: 'https://x.example.com', protocolVersion: '1.0' }],
    });
    expect(result.success).toBe(false);
  });

  it('renames legacy interface transport to protocolBinding and inherits protocolVersion', () => {
    const card = agentCardSchema.parse({
      ...VALID_CARD,
      protocolVersion: '0.3.0',
      preferredTransport: 'jsonrpc',
      additionalInterfaces: [{ transport: 'grpc', url: 'grpc.example.com:443' }, { transport: 'rest', url: 'https://climate.example.com/rest' }],
    });

    expect(card.supportedInterfaces).toEqual([
      { url: 'https://climate.example.com', protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' },
      { url: 'grpc.example.com:443', protocolBinding: 'GRPC', protocolVersion: '0.3.0' },
      { url: 'https://climate.example.com/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '0.3.0' },
    ]);
    expect((card as Record<string, unknown>)['preferredTransport']).toBeUndefined();
    expect((card as Record<string, unknown>)['additionalInterfaces']).toBeUndefined();
  });

  it('maps provider.name, supportsAuthenticatedExtendedCard, and security to their v1.0 homes', () => {
    const card = agentCardSchema.parse({
      ...VALID_CARD,
      provider: { name: 'Northwind', url: 'https://northwind.example.com' },
      supportsAuthenticatedExtendedCard: true,
      securitySchemes: {
        google: { openIdConnectSecurityScheme: { openIdConnectUrl: 'https://accounts.google.com/.well-known/openid-configuration' } },
      },
      security: [{ google: ['openid', 'email'] }],
    });

    expect(card.provider).toEqual({ organization: 'Northwind', url: 'https://northwind.example.com' });
    expect(card.capabilities.extendedAgentCard).toBe(true);
    expect(card.securityRequirements).toEqual([{ schemes: { google: { list: ['openid', 'email'] } } }]);
    expect((card as Record<string, unknown>)['security']).toBeUndefined();
    expect((card as Record<string, unknown>)['supportsAuthenticatedExtendedCard']).toBeUndefined();
  });

  it('no longer defaults the removed capabilities.stateTransitionHistory flag', () => {
    const card = agentCardSchema.parse(VALID_CARD);
    expect(card.capabilities.stateTransitionHistory).toBeUndefined();

    const legacy = agentCardSchema.parse({ ...VALID_CARD, capabilities: { stateTransitionHistory: true } });
    expect(legacy.capabilities.stateTransitionHistory).toBe(true);
  });

  it('accepts signatures and per-skill security requirements', () => {
    const card = agentCardSchema.parse({
      ...VALID_CARD,
      signatures: [{ protected: 'eyJhbGciOiJFUzI1NiJ9', signature: 'abc', header: { kid: 'k1' } }],
      skills: [{ ...VALID_CARD.skills[0], securityRequirements: [{ schemes: { apiKey: { list: [] } } }] }],
    });
    expect(card.signatures?.[0].protected).toBe('eyJhbGciOiJFUzI1NiJ9');
    expect(card.skills[0].securityRequirements).toHaveLength(1);
  });
});

describe('createAgentCard / createExternalAgentCard', () => {
  it('emits a transitional card: v1.0 supportedInterfaces plus legacy url and protocolVersion', () => {
    const card = createAgentCard({
      handle: 'climate-watch',
      interests: [{ topic: 'carbon capture' }],
      cadence: '6h',
      url: 'https://climate.example.com/a2a',
    });

    expect(card.supportedInterfaces).toEqual([
      { url: 'https://climate.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.2.1' },
    ]);
    expect(card.url).toBe('https://climate.example.com/a2a');
    expect(card.protocolVersion).toBe('0.2.1');
    expect(card.capabilities.stateTransitionHistory).toBeUndefined();
    expect(card.skills.every((s) => s.tags.length > 0)).toBe(true);
  });

  it('lets external cards override supportedInterfaces', () => {
    const card = createExternalAgentCard({
      name: 'Modern',
      url: 'https://modern.example.com',
      supportedInterfaces: [{ url: 'https://modern.example.com/a2a/v1', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    });
    expect(card.supportedInterfaces[0].protocolBinding).toBe('HTTP+JSON');
    expect(card.url).toBe('https://modern.example.com');
  });
});

describe('agent card helpers', () => {
  it('toV1AgentCard strips legacy fields and the removed capability flag', () => {
    const card = createAgentCard({ handle: 'abc', interests: [{ topic: 'x' }], cadence: '1d' });
    const v1 = toV1AgentCard({ ...card, capabilities: { ...card.capabilities, stateTransitionHistory: false } });

    expect('url' in v1).toBe(false);
    expect('protocolVersion' in v1).toBe(false);
    expect('stateTransitionHistory' in v1.capabilities).toBe(false);
    expect(v1.supportedInterfaces[0].url).toBe('http://localhost:3141');
    expect(v1.youagent?.handle).toBe('abc');
  });

  it('getPrimaryInterface / getAgentUrl prefer supportedInterfaces and fall back to legacy url', () => {
    const modern = agentCardSchema.parse({
      ...VALID_CARD,
      url: 'https://legacy.example.com',
      supportedInterfaces: [{ url: 'https://preferred.example.com', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    });
    expect(getAgentUrl(modern)).toBe('https://preferred.example.com');

    const legacyOnly = { ...VALID_CARD, version: '0.1.0', capabilities: {}, defaultInputModes: [], defaultOutputModes: [], supportedInterfaces: [] };
    expect(getPrimaryInterface(legacyOnly)).toEqual({
      url: 'https://climate.example.com',
      protocolBinding: 'JSONRPC',
      protocolVersion: '0.2.1',
    });
    expect(getAgentIdentifier(legacyOnly).id).toBe('https://climate.example.com');
  });

  it('toProtocolBinding maps pre-1.0 transport names and passes custom bindings through', () => {
    expect(toProtocolBinding('jsonrpc')).toBe('JSONRPC');
    expect(toProtocolBinding('GRPC')).toBe('GRPC');
    expect(toProtocolBinding('rest')).toBe('HTTP+JSON');
    expect(toProtocolBinding('https://example.com/bindings/custom')).toBe('https://example.com/bindings/custom');
  });

  it('normalizeAgentCard leaves non-object input alone and is idempotent', () => {
    expect(normalizeAgentCard(null)).toBeNull();
    expect(normalizeAgentCard('nope')).toBe('nope');

    const once = normalizeAgentCard({ ...VALID_CARD, protocolVersion: '0.2.1' });
    expect(normalizeAgentCard(once)).toEqual(once);
  });
});
