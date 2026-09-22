import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A2AServer } from './a2a-server.js';
import { A2AClient } from './a2a-client.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import { agentCardSchema } from '../schema/agent-card.schema.js';
import { A2A_WELL_KNOWN_PATH } from '../types/agent-card.js';
import {
  A2A_JWKS_PATH,
  AgentCardSignatureError,
  decodeProtectedHeader,
  generateCardSigningKeyPair,
  toPublicJwk,
  verifyAgentCardSignatures,
} from './card-signing.js';
import { fetchAgentCard, fetchVerifiedAgentCard } from './discovery.js';

describe('A2AServer card signing', () => {
  const { privateKey, publicKey } = generateCardSigningKeyPair('ES256');
  const rotatedOut = generateCardSigningKeyPair('ES256');
  let server: A2AServer;
  let base: string;

  beforeAll(async () => {
    // Bind first so the card url (and therefore the default jku) carries the real port.
    const probe = new A2AServer({ agentCard: createAgentCard({ handle: 'probe', interests: [{ topic: 'x' }], cadence: '6h' }), port: 0 });
    await probe.start();
    const port = probe.address()!.port;
    await probe.stop();
    base = `http://127.0.0.1:${port}`;

    const card = createAgentCard({
      handle: 'climate-watch',
      displayName: 'Climate Watch',
      interests: [{ topic: 'carbon capture' }],
      cadence: '6h',
      url: `${base}/a2a`,
    });
    server = new A2AServer({
      agentCard: card,
      port,
      signing: { key: privateKey, kid: 'key-2026-09', additionalJwks: [toPublicJwk(rotatedOut.publicKey, { kid: 'key-2026-03' })] },
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves a signed card whose jku points at this origin, and the card still validates', async () => {
    const res = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);
    const body = await res.json();
    expect(body.signatures).toHaveLength(1);
    const header = decodeProtectedHeader(body.signatures[0]);
    expect(header).toEqual({ alg: 'ES256', typ: 'JOSE', kid: 'key-2026-09', jku: `${base}${A2A_JWKS_PATH}` });
    expect(() => agentCardSchema.parse(body)).not.toThrow();
    expect(server.agentCard.signatures).toHaveLength(1);
  });

  it('serves the same signed card on every discovery path with one ETag', async () => {
    const v1 = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);
    const legacy = await fetch(`${base}/.well-known/agent.json`);
    expect(legacy.headers.get('etag')).toBe(v1.headers.get('etag'));
    expect(await legacy.json()).toEqual(await v1.json());
  });

  it('publishes the JWK Set at /.well-known/jwks.json, including rotated-out keys', async () => {
    const res = await fetch(`${base}${A2A_JWKS_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const jwks = await res.json();
    expect(jwks.keys.map((k: { kid: string }) => k.kid)).toEqual(['key-2026-09', 'key-2026-03']);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    expect(server.jwkSet).toEqual(jwks);

    const head = await fetch(`${base}${A2A_JWKS_PATH}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('is verifiable end to end through fetchAgentCard with the default same-origin JWKS policy', async () => {
    const { card, verification } = await fetchVerifiedAgentCard(base, { signature: {} });
    expect(card.name).toBe('Climate Watch');
    expect(verification).toMatchObject({ kid: 'key-2026-09', alg: 'ES256', jku: `${base}${A2A_JWKS_PATH}` });

    const client = new A2AClient(card);
    await expect(client.discover(base, { signature: {} })).resolves.toMatchObject({ name: 'Climate Watch' });
  });

  it('verifies against a pinned key without touching the network', async () => {
    const card = await fetchAgentCard(base);
    const result = await verifyAgentCardSignatures(card, {
      keys: [publicKey],
      jwks: { origins: [], fetchImpl: () => Promise.reject(new Error('network must not be used')) },
    });
    expect(result.kid).toBe('key-2026-09');
  });

  it('rejects the card when the JWKS origin is not trusted', async () => {
    await expect(
      fetchAgentCard(base, { signature: { jwks: { origins: ['https://somewhere-else.example'] } } }),
    ).rejects.toBeInstanceOf(AgentCardSignatureError);
  });

  it('rejects a card whose fetched bytes were altered in transit', async () => {
    const tamperingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith(A2A_WELL_KNOWN_PATH)) {
        const body = await res.json();
        body.description = 'tampered by a mirror';
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return res;
    };
    const err = await fetchAgentCard(base, { fetchImpl: tamperingFetch, signature: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCardSignatureError);
    expect((err as AgentCardSignatureError).code).toBe('invalid_signatures');
  });
});

describe('A2AServer without signing', () => {
  const card = createAgentCard({ handle: 'plain', interests: [{ topic: 'x' }], cadence: '6h' });
  let server: A2AServer;
  let base: string;

  beforeAll(async () => {
    server = new A2AServer({ agentCard: card, port: 0 });
    await server.start();
    base = `http://127.0.0.1:${server.address()!.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves the card unsigned and has no JWKS route', async () => {
    const body = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(body.signatures).toBeUndefined();
    expect(server.jwkSet).toBeNull();
    expect((await fetch(`${base}${A2A_JWKS_PATH}`)).status).toBe(404);
  });

  it('fails required verification, passes optional verification with no result', async () => {
    const err = await fetchAgentCard(base, { signature: {} }).catch((e: unknown) => e);
    expect((err as AgentCardSignatureError).code).toBe('no_signatures');

    const { verification } = await fetchVerifiedAgentCard(base, { signature: { require: false } });
    expect(verification).toBeUndefined();
  });

  it('requires an explicit jku when the card url is not a URL', () => {
    const { privateKey } = generateCardSigningKeyPair('EdDSA');
    const odd = { ...card, supportedInterfaces: [], url: 'not-a-url' };
    expect(() => new A2AServer({ agentCard: odd, port: 0, signing: { key: privateKey, kid: 'k' } })).toThrow(/signing.jku/);
    expect(() => new A2AServer({ agentCard: odd, port: 0, signing: { key: privateKey, kid: 'k', jku: false } })).not.toThrow();
  });
});
