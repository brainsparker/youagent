import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2AServer, type A2AServerConfig } from './a2a-server.js';
import { A2AAuthenticationError, A2AClient } from './a2a-client.js';
import {
  API_KEY_SCHEME_NAME,
  BEARER_SCHEME_NAME,
  resolveAuth,
  securityRequirementsFor,
  securitySchemesFor,
  withDeclaredSecurity,
} from './auth.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import { A2A_WELL_KNOWN_PATH, type AgentCard } from '../types/agent-card.js';
import type { JsonRpcResponse, Task } from './types.js';

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [{ topic: 'carbon capture' }],
  cadence: '6h',
  url: 'https://climate.example.com/a2a',
});

const senderCard = createAgentCard({
  handle: 'follower',
  displayName: 'Follower',
  interests: [{ topic: 'grid storage' }],
  cadence: '1d',
  url: 'https://follower.example.com/a2a',
});

const TOKEN = 'tok_climate_5f3a9c';
const OTHER_TOKEN = 'tok_other_agent_1b2c';
const API_KEY = 'key_2d8e7f';

const servers: A2AServer[] = [];

async function startServer(config: Partial<A2AServerConfig> = {}): Promise<{ server: A2AServer; base: string }> {
  const server = new A2AServer({ agentCard: card, port: 0, host: '127.0.0.1', ...config });
  server.registerYouAgentHandlers({});
  await server.start();
  servers.push(server);
  const address = server.address();
  if (!address) throw new Error('server did not bind');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function sendMessageBody(text = 'hello'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text }] } },
  });
}

async function post(base: string, headers: Record<string, string> = {}, body = sendMessageBody()): Promise<Response> {
  return fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('A2AServer without auth', () => {
  it('keeps accepting unauthenticated JSON-RPC calls and serves the card unchanged', async () => {
    const { server, base } = await startServer();

    const res = await post(base);
    expect(res.status).toBe(200);
    const json = (await res.json()) as JsonRpcResponse;
    expect((json.result as Task).status.state).toBe('completed');

    expect(server.authRequired).toBe(false);
    const served = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(served.securitySchemes).toBeUndefined();
    expect(served.securityRequirements).toBeUndefined();
  });
});

describe('A2AServer with bearer token auth', () => {
  it('answers 401 with a WWW-Authenticate challenge when no credential is presented', async () => {
    const { base } = await startServer({ auth: { bearerTokens: [TOKEN] } });

    const res = await post(base);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="Climate Watch"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.securitySchemes).toEqual([BEARER_SCHEME_NAME]);
    // HTTP-level rejection, not a JSON-RPC error envelope.
    expect(body.jsonrpc).toBeUndefined();
  });

  it('answers 401 for a wrong token, a token in the wrong scheme, and a malformed header', async () => {
    const { base } = await startServer({ auth: { bearerTokens: [TOKEN] } });

    const wrong = await post(base, { Authorization: `Bearer ${OTHER_TOKEN}` });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).message).toBe('The presented credential was not accepted');

    const basic = await post(base, { Authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` });
    expect(basic.status).toBe(401);

    const prefix = await post(base, { Authorization: `Bearer ${TOKEN.slice(0, -1)}` });
    expect(prefix.status).toBe(401);

    const asApiKey = await post(base, { 'X-API-Key': TOKEN });
    expect(asApiKey.status).toBe(401);
  });

  it('accepts any configured token and exposes the auth context to handlers', async () => {
    const { server, base } = await startServer({ auth: { bearerTokens: [TOKEN, OTHER_TOKEN] } });
    let seen: unknown;
    server.onMethod('message/send', async (_params, request) => {
      seen = request.auth;
      return { ok: true };
    });

    const first = await post(base, { Authorization: `Bearer ${TOKEN}` });
    expect(first.status).toBe(200);
    expect(((await first.json()) as JsonRpcResponse).result).toEqual({ ok: true });
    expect(seen).toEqual({ scheme: 'bearer' });

    const second = await post(base, { Authorization: `bearer ${OTHER_TOKEN}` });
    expect(second.status).toBe(200);
  });

  it('declares the enforced scheme on the served card without mutating the configured card', async () => {
    const { server, base } = await startServer({ auth: { bearerTokens: [TOKEN] } });

    const served = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(served.securitySchemes).toEqual({
      [BEARER_SCHEME_NAME]: {
        httpAuthSecurityScheme: { scheme: 'bearer', description: 'Authorization: Bearer <token>' },
      },
    });
    expect(served.securityRequirements).toEqual([{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }]);
    expect(server.agentCard.securitySchemes).toEqual(served.securitySchemes);
    expect(server.authRequired).toBe(true);

    // The card object the embedder passed in is untouched (it may be persisted elsewhere).
    expect(card.securitySchemes).toBeUndefined();
    expect(card.securityRequirements).toBeUndefined();
  });

  it('keeps card discovery, /health, and the feeds public by default', async () => {
    const { base } = await startServer({
      auth: { bearerTokens: [TOKEN] },
      feed: { getPosts: () => [] },
    });

    expect((await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).status).toBe(200);
    expect((await fetch(`${base}/.well-known/agent.json`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/feed.xml`)).status).toBe(200);
    expect((await fetch(`${base}/feed.json`)).status).toBe(200);
  });

  it('protects the feeds too when protectFeeds is set', async () => {
    const { base } = await startServer({
      auth: { bearerTokens: [TOKEN], protectFeeds: true },
      feed: { getPosts: () => [] },
    });

    const anonymous = await fetch(`${base}/feed.xml`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');

    const authed = await fetch(`${base}/feed.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(authed.status).toBe(200);

    // Discovery stays public even then: clients need the card to learn the schemes.
    expect((await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('uses a custom realm in the challenge when configured', async () => {
    const { base } = await startServer({ auth: { bearerTokens: [TOKEN], realm: 'climate "prod"' } });
    const res = await post(base);
    // Quotes are stripped rather than escaped so the header stays well formed.
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="climate prod"');
  });
});

describe('A2AServer with API key auth', () => {
  it('accepts the key in X-API-Key by default and declares the apiKey scheme', async () => {
    const { base } = await startServer({ auth: { apiKeys: [API_KEY] } });

    const anonymous = await post(base);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('ApiKey realm="Climate Watch", header="X-API-Key"');

    const ok = await post(base, { 'X-API-Key': API_KEY });
    expect(ok.status).toBe(200);

    const wrong = await post(base, { 'X-API-Key': 'nope' });
    expect(wrong.status).toBe(401);

    const served = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(served.securitySchemes).toEqual({
      [API_KEY_SCHEME_NAME]: {
        apiKeySecurityScheme: { name: 'X-API-Key', location: 'header', description: 'X-API-Key: <key>' },
      },
    });
    expect(served.securityRequirements).toEqual([{ schemes: { [API_KEY_SCHEME_NAME]: { list: [] } } }]);
  });

  it('reads a custom header name, case-insensitively', async () => {
    const { base } = await startServer({ auth: { apiKeys: [API_KEY], apiKeyHeader: 'X-Agent-Key' } });

    expect((await post(base, { 'x-agent-key': API_KEY })).status).toBe(200);
    expect((await post(base, { 'X-API-Key': API_KEY })).status).toBe(401);

    const served = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(served.securitySchemes.apiKey.apiKeySecurityScheme.name).toBe('X-Agent-Key');
  });

  it('offers both schemes when both are configured and Authorization wins when both are sent', async () => {
    const { base } = await startServer({ auth: { bearerTokens: [TOKEN], apiKeys: [API_KEY] } });

    const anonymous = await post(base);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      'Bearer realm="Climate Watch", ApiKey realm="Climate Watch", header="X-API-Key"',
    );

    expect((await post(base, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await post(base, { 'X-API-Key': API_KEY })).status).toBe(200);
    // A bad bearer token is not rescued by a good API key on the same request.
    expect((await post(base, { Authorization: 'Bearer nope', 'X-API-Key': API_KEY })).status).toBe(401);

    const served = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(Object.keys(served.securitySchemes).sort()).toEqual([API_KEY_SCHEME_NAME, BEARER_SCHEME_NAME]);
    expect(served.securityRequirements).toHaveLength(2);
  });
});

describe('A2AServer with a custom verifier', () => {
  it('consults verify after the static lists and records the principal it returns', async () => {
    const verify = vi.fn(async (credential: { scheme: string; token?: string }) =>
      credential.scheme === 'bearer' && credential.token === 'jwt.for.alice' ? { principal: 'alice' } : false,
    );
    const { server, base } = await startServer({ auth: { bearerTokens: [TOKEN], verify } });
    let seen: unknown;
    server.onMethod('message/send', async (_params, request) => {
      seen = request.auth;
      return {};
    });

    // Static token: verify is not consulted.
    expect((await post(base, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
    expect(seen).toEqual({ scheme: 'bearer' });

    // Unknown token: verify decides.
    expect((await post(base, { Authorization: 'Bearer jwt.for.alice' })).status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ scheme: 'bearer', principal: 'alice' });

    expect((await post(base, { Authorization: 'Bearer jwt.for.mallory' })).status).toBe(401);
  });

  it('treats a throwing verifier as a rejection', async () => {
    const { base } = await startServer({
      auth: {
        verify: () => {
          throw new Error('key store unavailable');
        },
      },
    });
    const res = await post(base, { Authorization: 'Bearer anything' });
    expect(res.status).toBe(401);
  });

  it('advertises both schemes when only a verifier is configured', async () => {
    const { base } = await startServer({ auth: { verify: () => true } });
    const served = await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json();
    expect(Object.keys(served.securitySchemes).sort()).toEqual([API_KEY_SCHEME_NAME, BEARER_SCHEME_NAME]);
    expect((await post(base, { 'X-API-Key': 'anything' })).status).toBe(200);
  });
});

describe('A2AServer auth configuration', () => {
  it('rejects a configuration that can authenticate nobody', () => {
    expect(() => new A2AServer({ agentCard: card, auth: {} })).toThrow(/accepts no credentials/);
    expect(() => new A2AServer({ agentCard: card, auth: { bearerTokens: ['', ''] } })).toThrow(
      /accepts no credentials/,
    );
  });

  it('rejects an API key header that cannot work', () => {
    expect(() => resolveAuth({ apiKeys: [API_KEY], apiKeyHeader: 'Authorization' })).toThrow(/Authorization/);
    expect(() => resolveAuth({ apiKeys: [API_KEY], apiKeyHeader: 'bad header' })).toThrow(/header name/);
    expect(() => resolveAuth({ apiKeys: [API_KEY], apiKeyHeader: '' })).toThrow(/header name/);
  });

  it('merges declared schemes into a card that already declares some', () => {
    const auth = resolveAuth({ bearerTokens: [TOKEN] });
    const declared: AgentCard = {
      ...card,
      securitySchemes: {
        oauth: { oauth2SecurityScheme: { flows: {} } },
        [BEARER_SCHEME_NAME]: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      securityRequirements: [{ schemes: { oauth: { list: ['read'] } } }, { schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }],
    };

    const merged = withDeclaredSecurity(declared, auth);

    expect(Object.keys(merged.securitySchemes!).sort()).toEqual([BEARER_SCHEME_NAME, 'oauth']);
    // The server's own description of the scheme it enforces replaces the embedder's entry of the same name.
    expect(merged.securitySchemes![BEARER_SCHEME_NAME]).toEqual(securitySchemesFor(auth)[BEARER_SCHEME_NAME]);
    // An already-present requirement is not duplicated.
    expect(merged.securityRequirements).toEqual(declared.securityRequirements);
    expect(securityRequirementsFor(auth)).toEqual([{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }]);
  });

  it('binds to the requested host', async () => {
    const { server } = await startServer({ host: '127.0.0.1' });
    expect(server.address()?.address).toBe('127.0.0.1');
  });
});

describe('A2AClient credentials', () => {
  it('sends a configured bearer token and the server accepts it', async () => {
    const { base } = await startServer({ auth: { bearerTokens: [TOKEN] } });
    const client = new A2AClient(senderCard, { credentials: { bearerToken: TOKEN } });

    const task = await client.sendText(base, 'hello');
    expect(task.status.state).toBe('completed');
  });

  it('sends a configured API key in the configured header', async () => {
    const { base } = await startServer({ auth: { apiKeys: [API_KEY], apiKeyHeader: 'X-Agent-Key' } });
    const client = new A2AClient(senderCard, { credentials: { apiKey: API_KEY, apiKeyHeader: 'X-Agent-Key' } });

    const task = await client.sendText(base, 'hello');
    expect(task.status.state).toBe('completed');
  });

  it('resolves per-agent credentials with credentialsFor, falling back to the defaults', async () => {
    const a = await startServer({ auth: { bearerTokens: [TOKEN] } });
    const b = await startServer({ auth: { bearerTokens: [OTHER_TOKEN] } });
    const client = new A2AClient(senderCard, {
      credentials: { bearerToken: TOKEN },
      credentialsFor: (url) => (url === b.base ? { bearerToken: OTHER_TOKEN } : undefined),
    });

    expect((await client.sendText(a.base, 'hi')).status.state).toBe('completed');
    expect((await client.sendText(b.base, 'hi')).status.state).toBe('completed');
  });

  it('throws A2AAuthenticationError on 401 without retrying', async () => {
    const { base } = await startServer({ auth: { bearerTokens: [TOKEN] } });
    const fetchSpy = vi.fn(globalThis.fetch);
    const client = new A2AClient(senderCard, { credentials: { bearerToken: 'wrong' }, fetch: fetchSpy });

    const err = await client.sendText(base, 'hello').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(A2AAuthenticationError);
    const authErr = err as A2AAuthenticationError;
    expect(authErr.status).toBe(401);
    expect(authErr.agentUrl).toBe(base);
    expect(authErr.challenge).toBe('Bearer realm="Climate Watch"');
    expect(authErr.message).toContain('authentication required');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends nothing extra when no credentials are configured', async () => {
    const { server, base } = await startServer();
    let authorization: string | undefined;
    let apiKey: string | undefined;
    server.onMethod('message/send', async () => ({}));
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      authorization = headers['Authorization'];
      apiKey = headers['X-API-Key'];
      return globalThis.fetch(url, init);
    });
    const client = new A2AClient(senderCard, { fetch: fetchSpy as unknown as typeof fetch });

    await client.sendText(base, 'hello');
    expect(authorization).toBeUndefined();
    expect(apiKey).toBeUndefined();
  });
});
