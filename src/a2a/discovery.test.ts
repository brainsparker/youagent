import { describe, expect, it, vi } from 'vitest';
import { AgentCardDiscoveryError, fetchAgentCard } from './discovery.js';

const LEGACY_CARD = {
  name: 'Legacy Agent',
  description: 'Still on the 0.2 card shape',
  url: 'https://legacy.test/a2a',
  version: '1.4.0',
  protocolVersion: '0.2.5',
  capabilities: { streaming: false },
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const V1_CARD = {
  name: 'Modern Agent',
  description: 'Already on v1.0',
  supportedInterfaces: [
    { url: 'https://modern.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  version: '2.0.0',
  capabilities: { streaming: true },
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

function asFetch(mock: FetchMock): typeof fetch {
  return mock as unknown as typeof fetch;
}

/** Await a rejection and return it typed as AgentCardDiscoveryError. */
async function rejectionOf(promise: Promise<unknown>): Promise<AgentCardDiscoveryError> {
  try {
    await promise;
  } catch (err) {
    return err as AgentCardDiscoveryError;
  }
  throw new Error('expected the promise to reject');
}

describe('fetchAgentCard', () => {
  it('fetches the v1.0 well-known path first and sends an a2a+json Accept header', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse(V1_CARD));

    const card = await fetchAgentCard('https://modern.test/', { fetchImpl: asFetch(fetchMock) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://modern.test/.well-known/agent-card.json');
    expect((init?.headers as Record<string, string>)['Accept']).toBe(
      'application/a2a+json, application/json;q=0.9',
    );
    expect(card.supportedInterfaces[0].url).toBe('https://modern.test/a2a');
    // A v1.0-only card gains the transitional url so legacy code paths work.
    expect(card.url).toBe('https://modern.test/a2a');
  });

  it('falls back to /.well-known/agent.json and upgrades the legacy card', async () => {
    const fetchMock: FetchMock = vi.fn(async (url: string) =>
      url.endsWith('/agent-card.json') ? new Response('not found', { status: 404 }) : jsonResponse(LEGACY_CARD),
    );

    const card = await fetchAgentCard('https://legacy.test', { fetchImpl: asFetch(fetchMock) });

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://legacy.test/.well-known/agent-card.json',
      'https://legacy.test/.well-known/agent.json',
    ]);
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://legacy.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.2.5' },
    ]);
    expect(card.url).toBe('https://legacy.test/a2a');
    expect(card.protocolVersion).toBe('0.2.5');
  });

  it('throws AgentCardDiscoveryError with every attempt when both paths fail', async () => {
    const fetchMock: FetchMock = vi.fn(async (url: string) =>
      url.endsWith('/agent-card.json')
        ? new Response('gone', { status: 410 })
        : new Response('missing', { status: 404 }),
    );

    const err = await rejectionOf(fetchAgentCard('https://nobody.test', { fetchImpl: asFetch(fetchMock) }));

    expect(err).toBeInstanceOf(AgentCardDiscoveryError);
    expect(err.status).toBe(404);
    expect(err.attempts).toHaveLength(2);
    expect(err.attempts[0]).toMatchObject({ url: 'https://nobody.test/.well-known/agent-card.json', status: 410 });
    expect(err.message).toContain('HTTP 410');
    expect(err.message).toContain('HTTP 404');
  });

  it('reports network failures as status 0', async () => {
    const fetchMock: FetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const err = await rejectionOf(fetchAgentCard('https://down.test', { fetchImpl: asFetch(fetchMock) }));

    expect(err).toBeInstanceOf(AgentCardDiscoveryError);
    expect(err.status).toBe(0);
    expect(err.attempts.every((a) => a.status === 0 && a.error === 'ECONNREFUSED')).toBe(true);
  });

  it('lets callers override the probed paths', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse(V1_CARD));

    await fetchAgentCard('https://custom.test', {
      fetchImpl: asFetch(fetchMock),
      paths: ['/agent-card'],
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://custom.test/agent-card');
  });
});
