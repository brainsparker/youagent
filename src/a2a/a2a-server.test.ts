import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A2AServer } from './a2a-server.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import {
  A2A_CARD_MEDIA_TYPE,
  A2A_LEGACY_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
} from '../types/agent-card.js';

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [{ topic: 'carbon capture' }],
  cadence: '6h',
  url: 'https://climate.example.com/a2a',
});

describe('A2AServer agent card discovery', () => {
  let server: A2AServer;
  let base: string;

  beforeAll(async () => {
    server = new A2AServer({ agentCard: card, port: 0 });
    await server.start();
    const address = server.address();
    if (!address) throw new Error('server did not bind');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves the card at the A2A v1.0 well-known path with the a2a+json media type', async () => {
    const res = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(A2A_CARD_MEDIA_TYPE);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);

    const body = await res.json();
    expect(body.name).toBe('Climate Watch');
    expect(body.supportedInterfaces).toEqual([
      { url: 'https://climate.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.2.1' },
    ]);
    // Transitional card: legacy fields stay for pre-1.0 readers.
    expect(body.url).toBe('https://climate.example.com/a2a');
    expect(body.protocolVersion).toBe('0.2.1');
  });

  it('keeps serving the pre-1.0 path and the /agent-card alias as application/json', async () => {
    const v1 = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);
    const legacy = await fetch(`${base}${A2A_LEGACY_WELL_KNOWN_PATH}`);
    const alias = await fetch(`${base}/agent-card`);

    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('content-type')).toBe('application/json');
    expect(alias.status).toBe(200);
    // Same content, same ETag on every path.
    expect(legacy.headers.get('etag')).toBe(v1.headers.get('etag'));
    expect(alias.headers.get('etag')).toBe(v1.headers.get('etag'));
    expect(await legacy.json()).toEqual(await v1.json());
  });

  it('answers 304 Not Modified to a matching If-None-Match', async () => {
    const first = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);
    const etag = first.headers.get('etag')!;

    const strong = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`, {
      headers: { 'If-None-Match': etag },
    });
    expect(strong.status).toBe(304);
    expect(strong.headers.get('etag')).toBe(etag);
    expect(await strong.text()).toBe('');

    const weak = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`, {
      headers: { 'If-None-Match': `W/${etag}` },
    });
    expect(weak.status).toBe(304);

    const star = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`, {
      headers: { 'If-None-Match': '*' },
    });
    expect(star.status).toBe(304);

    const stale = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`, {
      headers: { 'If-None-Match': '"deadbeef"' },
    });
    expect(stale.status).toBe(200);
  });

  it('ignores query strings on the discovery path', async () => {
    const res = await fetch(`${base}${A2A_WELL_KNOWN_PATH}?cache=bust`);
    expect(res.status).toBe(200);
  });

  it('supports HEAD on the discovery path', async () => {
    const res = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(A2A_CARD_MEDIA_TYPE);
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await res.text()).toBe('');
  });

  it('still serves /health and 404s unknown paths', async () => {
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ status: 'ok' });

    const missing = await fetch(`${base}/.well-known/something-else.json`);
    expect(missing.status).toBe(404);
  });
});

describe('A2AServer cardMaxAgeSeconds', () => {
  it('honors a custom max-age and clamps negatives to 0', async () => {
    const server = new A2AServer({ agentCard: card, port: 0, cardMaxAgeSeconds: -5 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.address()!.port}${A2A_WELL_KNOWN_PATH}`);
      expect(res.headers.get('cache-control')).toBe('public, max-age=0');
    } finally {
      await server.stop();
    }
  });
});
