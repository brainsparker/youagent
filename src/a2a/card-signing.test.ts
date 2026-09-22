import { describe, expect, it, vi } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { createAgentCard } from '../schema/agent-card.schema.js';
import { toV1AgentCard, type AgentCard } from '../types/agent-card.js';
import {
  AgentCardSignatureError,
  CanonicalizationError,
  agentCardSigningPayload,
  canonicalizeJson,
  decodeProtectedHeader,
  generateCardSigningKeyPair,
  jkuAllowed,
  removeEmptyValues,
  signAgentCard,
  toPublicJwk,
  verifyAgentCardSignatures,
  type CardSigningAlgorithm,
} from './card-signing.js';

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  description: 'Tracks carbon capture pilots',
  interests: [{ topic: 'carbon capture', weight: 1 }],
  cadence: '6h',
  url: 'https://climate.example.com/a2a',
});

const jwksUrl = 'https://climate.example.com/.well-known/jwks.json';

describe('canonicalizeJson (RFC 8785)', () => {
  it('sorts keys, strips whitespace and keeps ECMAScript number formatting', () => {
    const value = { b: [1, 2.5, 1e21, 1e-7, 0.000001, -0], a: { z: true, y: null, x: 'text' }, c: 100000000000000000000 };
    expect(canonicalizeJson(value)).toBe(
      '{"a":{"x":"text","y":null,"z":true},"b":[1,2.5,1e+21,1e-7,0.000001,0],"c":100000000000000000000}',
    );
  });

  it('orders keys by UTF-16 code units, not code points', () => {
    // U+1F600 is a surrogate pair starting 0xD83D, which sorts before U+FF61 (0xFF61) in code units.
    const value: Record<string, number> = {};
    value['｡'] = 1;
    value['\u{1f600}'] = 2;
    expect(canonicalizeJson(value)).toBe('{"\u{1f600}":2,"｡":1}');
  });

  it('escapes control characters minimally and leaves non-ASCII literal', () => {
    expect(canonicalizeJson({ s: 'tab\tnl\nquote"bs\\escé€' })).toBe(
      '{"s":"tab\\tnl\\nquote\\"bs\\\\esc\\u001bé€"}',
    );
  });

  it('matches the specification example after empty values are removed', () => {
    const fragment = {
      name: 'Example Agent',
      description: 'Demo',
      capabilities: { streaming: false, pushNotifications: false, extensions: [] },
      skills: [{ id: 's', name: 'S', description: 'D', tags: ['t'] }],
    };
    expect(canonicalizeJson(removeEmptyValues(fragment))).toBe(
      '{"capabilities":{"pushNotifications":false,"streaming":false},"description":"Demo","name":"Example Agent","skills":[{"description":"D","id":"s","name":"S","tags":["t"]}]}',
    );
  });

  it('rejects values with no canonical form', () => {
    expect(() => canonicalizeJson({ n: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson({ s: '\ud800' })).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson({ f: () => 1 })).toThrow(CanonicalizationError);
  });

  it('bounds nesting depth', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(() => canonicalizeJson(deep)).toThrow(/depth/);
    expect(() => removeEmptyValues(deep)).toThrow(/depth/);
  });
});

describe('agentCardSigningPayload', () => {
  it('excludes signatures and drops null, empty strings, arrays and objects recursively', () => {
    const payload = agentCardSigningPayload({
      name: 'A',
      description: '',
      signatures: [{ protected: 'x', signature: 'y' }],
      provider: { organization: '', url: null },
      skills: [],
      capabilities: { streaming: false, extensions: [{ params: {} }] },
      nested: { list: [null, '', {}], keep: 0 },
    });
    expect(payload).toBe('{"capabilities":{"streaming":false},"name":"A","nested":{"keep":0}}');
  });

  it('is stable across key order and serialization differences', () => {
    const a = agentCardSigningPayload({ name: 'A', version: '1', skills: [{ id: 'x', tags: ['t'] }] });
    const b = agentCardSigningPayload(JSON.parse('{"skills":[{"tags":["t"],"id":"x"}],"version":"1","name":"A"}'));
    expect(a).toBe(b);
  });

  it('rejects non-object cards', () => {
    expect(() => agentCardSigningPayload([])).toThrow(CanonicalizationError);
    expect(() => agentCardSigningPayload(null)).toThrow(CanonicalizationError);
  });
});

describe('signAgentCard', () => {
  it('appends a JWS signature with the spec protected header and leaves the input untouched', () => {
    const { privateKey } = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'key-1', jku: jwksUrl });

    expect(card.signatures).toBeUndefined();
    expect(signed.signatures).toHaveLength(1);
    const header = decodeProtectedHeader(signed.signatures![0]!);
    expect(header).toEqual({ alg: 'ES256', typ: 'JOSE', kid: 'key-1', jku: jwksUrl });
    expect(signed.signatures![0]!.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signed.signatures![0]!.header).toBeUndefined();
  });

  it('keeps existing signatures so keys can be rotated', () => {
    const first = generateCardSigningKeyPair('ES256');
    const second = generateCardSigningKeyPair('EdDSA');
    const once = signAgentCard(card, { key: first.privateKey, kid: 'old' });
    const twice = signAgentCard(once, { key: second.privateKey, kid: 'new', header: { note: 'rotation' } });
    expect(twice.signatures!.map((s) => decodeProtectedHeader(s).kid)).toEqual(['old', 'new']);
    expect(twice.signatures![1]!.header).toEqual({ note: 'rotation' });
  });

  it('accepts PEM and JWK private keys', () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('ES256');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const jwk = privateKey.export({ format: 'jwk' });
    const fromPem = signAgentCard(card, { key: pem, kid: 'k' });
    const fromJwk = signAgentCard(card, { key: jwk, kid: 'k' });
    return Promise.all([
      expect(verifyAgentCardSignatures(fromPem, { keys: [publicKey] })).resolves.toMatchObject({ kid: 'k' }),
      expect(verifyAgentCardSignatures(fromJwk, { keys: [publicKey] })).resolves.toMatchObject({ kid: 'k' }),
    ]);
  });

  it('refuses a key that does not match the requested algorithm', () => {
    const { privateKey } = generateCardSigningKeyPair('EdDSA');
    expect(() => signAgentCard(card, { key: privateKey, kid: 'k', alg: 'ES256' })).toThrow(/cannot sign with ES256/);
  });

  it('refuses a public key', () => {
    const { publicKey } = generateCardSigningKeyPair('ES256');
    expect(() => signAgentCard(card, { key: publicKey, kid: 'k' })).toThrow(/private key/);
  });
});

describe('verifyAgentCardSignatures', () => {
  const algorithms: CardSigningAlgorithm[] = ['ES256', 'ES384', 'ES512', 'EdDSA', 'RS256', 'PS256'];

  for (const alg of algorithms) {
    it(`round-trips with ${alg}`, async () => {
      const { privateKey, publicKey } = generateCardSigningKeyPair(alg);
      const signed = signAgentCard(card, { key: privateKey, kid: `${alg}-key`, alg });
      const result = await verifyAgentCardSignatures(signed, { keys: [publicKey] });
      expect(result.alg).toBe(alg);
      expect(result.kid).toBe(`${alg}-key`);
      expect(result.index).toBe(0);
    });
  }

  it('verifies against a JWK Set selected by kid', async () => {
    const a = generateCardSigningKeyPair('ES256');
    const b = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: b.privateKey, kid: 'b' });
    const jwks = { keys: [toPublicJwk(a.publicKey, { kid: 'a' }), toPublicJwk(b.publicKey, { kid: 'b' })] };
    const result = await verifyAgentCardSignatures(signed, { keys: jwks });
    expect(result.kid).toBe('b');
  });

  it('verifies a card that went through JSON serialization and reordering', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('EdDSA');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k' });
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()))) as AgentCard;
    await expect(verifyAgentCardSignatures(reordered, { keys: [publicKey] })).resolves.toMatchObject({ kid: 'k' });
  });

  it('rejects a tampered card', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k' });
    const tampered = { ...signed, description: 'Now tracks something else' };
    const err = await verifyAgentCardSignatures(tampered, { keys: [publicKey] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCardSignatureError);
    expect((err as AgentCardSignatureError).code).toBe('invalid_signatures');
    expect((err as AgentCardSignatureError).attempts[0]!.reason).toMatch(/does not verify/);
  });

  it('rejects when the legacy fields were stripped after signing (sign the form you serve)', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k' });
    await expect(verifyAgentCardSignatures(toV1AgentCard(signed), { keys: [publicKey] })).rejects.toThrow(
      AgentCardSignatureError,
    );
    // Signing the strict v1.0 form verifies the strict v1.0 form.
    const strict = signAgentCard(toV1AgentCard(card), { key: privateKey, kid: 'k' });
    await expect(verifyAgentCardSignatures(strict, { keys: [publicKey] })).resolves.toMatchObject({ kid: 'k' });
  });

  it('rejects a card with no signatures', async () => {
    const err = await verifyAgentCardSignatures(card, { keys: [] }).catch((e: unknown) => e);
    expect((err as AgentCardSignatureError).code).toBe('no_signatures');
  });

  it('rejects the wrong key and reports the reason per signature', async () => {
    const signer = generateCardSigningKeyPair('ES256');
    const other = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: signer.privateKey, kid: 'k' });
    const err = (await verifyAgentCardSignatures(signed, { keys: [other.publicKey] }).catch((e: unknown) => e)) as AgentCardSignatureError;
    expect(err.code).toBe('invalid_signatures');
    expect(err.attempts).toEqual([
      { index: 0, kid: 'k', alg: 'ES256', ok: false, reason: 'signature does not verify against the trusted key' },
    ]);
  });

  it('prevents algorithm confusion: an alg the key cannot serve is never tried', async () => {
    const ec = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: ec.privateKey, kid: 'k' });
    const rsa = generateCardSigningKeyPair('RS256');
    const err = (await verifyAgentCardSignatures(signed, { keys: [rsa.publicKey] }).catch((e: unknown) => e)) as AgentCardSignatureError;
    expect(err.attempts[0]!.reason).toBe('no candidate key matches algorithm ES256');
  });

  it('honours the allowed algorithm list', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('RS256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k' });
    const err = (await verifyAgentCardSignatures(signed, { keys: [publicKey], algorithms: ['ES256', 'EdDSA'] }).catch(
      (e: unknown) => e,
    )) as AgentCardSignatureError;
    expect(err.attempts[0]!.reason).toBe('algorithm RS256 is not accepted');
  });

  it('skips a malformed signature and accepts a later valid one', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k' });
    const withJunk = { ...signed, signatures: [{ protected: '!!!', signature: 'x' }, ...signed.signatures!] };
    const result = await verifyAgentCardSignatures(withJunk, { keys: [publicKey] });
    expect(result.index).toBe(1);
    expect(result.attempts[0]!.reason).toMatch(/protected header/);
  });

  it('consults a custom key resolver', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('EdDSA');
    const signed = signAgentCard(card, { key: privateKey, kid: 'resolver-key' });
    const resolveKey = vi.fn(async (header: { kid: string }) => (header.kid === 'resolver-key' ? publicKey : undefined));
    const result = await verifyAgentCardSignatures(signed, { resolveKey });
    expect(result.kid).toBe('resolver-key');
    expect(resolveKey).toHaveBeenCalledOnce();
  });

  it('fetches the JWKS from jku only on an allowed origin', async () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k', jku: jwksUrl });
    const jwks = { keys: [toPublicJwk(publicKey, { kid: 'k' })] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));

    const denied = (await verifyAgentCardSignatures(signed, {
      jwks: { origins: ['https://other.example'], fetchImpl: fetchMock as unknown as typeof fetch },
    }).catch((e: unknown) => e)) as AgentCardSignatureError;
    expect(denied.attempts[0]!.reason).toMatch(/not an allowed JWKS origin/);
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await verifyAgentCardSignatures(signed, {
      jwks: { origins: ['https://climate.example.com'], fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(result.kid).toBe('k');
    expect(result.jku).toBe(jwksUrl);
    expect(fetchMock).toHaveBeenCalledWith(jwksUrl, expect.objectContaining({ method: 'GET' }));
  });

  it('fetches each JWKS URL once per verification even with several signatures', async () => {
    const a = generateCardSigningKeyPair('ES256');
    const b = generateCardSigningKeyPair('ES256');
    // Only b's key is published; a's signature should fail and b's succeed with one fetch.
    const signed = signAgentCard(signAgentCard(card, { key: a.privateKey, kid: 'a', jku: jwksUrl }), {
      key: b.privateKey,
      kid: 'b',
      jku: jwksUrl,
    });
    const jwks = { keys: [toPublicJwk(b.publicKey, { kid: 'b' })] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
    const result = await verifyAgentCardSignatures(signed, {
      jwks: { origins: 'any', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(result.kid).toBe('b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]!.reason).toBe('no trusted key for kid a');
  });

  it('reports a failed JWKS fetch', async () => {
    const { privateKey } = generateCardSigningKeyPair('ES256');
    const signed = signAgentCard(card, { key: privateKey, kid: 'k', jku: jwksUrl });
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    const err = (await verifyAgentCardSignatures(signed, {
      jwks: { origins: 'any', fetchImpl: fetchMock as unknown as typeof fetch },
    }).catch((e: unknown) => e)) as AgentCardSignatureError;
    expect(err.attempts[0]!.reason).toMatch(/HTTP 500/);
  });
});

describe('jkuAllowed', () => {
  const policy = { origins: ['https://agent.example:8443'] };
  it('matches the exact origin including port', () => {
    expect(jkuAllowed('https://agent.example:8443/.well-known/jwks.json', policy)).toBe(true);
    expect(jkuAllowed('https://agent.example/.well-known/jwks.json', policy)).toBe(false);
    expect(jkuAllowed('https://evil.example/jwks.json', policy)).toBe(false);
  });
  it('requires https except for loopback hosts', () => {
    expect(jkuAllowed('http://agent.example/jwks.json', { origins: 'any' })).toBe(false);
    expect(jkuAllowed('http://127.0.0.1:3141/.well-known/jwks.json', { origins: 'any' })).toBe(true);
    expect(jkuAllowed('http://agent.example/jwks.json', { origins: 'any', requireHttps: false })).toBe(true);
    expect(jkuAllowed('ftp://agent.example/jwks.json', { origins: 'any', requireHttps: false })).toBe(false);
    expect(jkuAllowed('not a url', { origins: 'any' })).toBe(false);
  });
});

describe('toPublicJwk', () => {
  it('exports a public JWK with kid, alg and use, from a private or public key', () => {
    const { privateKey, publicKey } = generateCardSigningKeyPair('EdDSA');
    const fromPrivate = toPublicJwk(privateKey, { kid: 'k' });
    const fromPublic = toPublicJwk(publicKey, { kid: 'k' });
    expect(fromPrivate).toEqual(fromPublic);
    expect(fromPublic).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'k', alg: 'EdDSA', use: 'sig' });
    expect(fromPublic).not.toHaveProperty('d');
    // Round-trips back into a usable key.
    expect(createPublicKey({ key: fromPublic, format: 'jwk' }).asymmetricKeyType).toBe('ed25519');
  });
});
