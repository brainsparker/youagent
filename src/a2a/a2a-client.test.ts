import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2AClient } from './a2a-client.js';
import { fetchAgentCardJson, AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH } from './discovery.js';
import type { AgentCard } from '../types/agent-card.js';

const SENDER: AgentCard = {
  name: 'Sender',
  description: 'Sender agent',
  url: 'http://localhost:3141',
  version: '0.1.0',
  protocolVersion: '0.3.0',
  capabilities: {},
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  youagent: {
    id: '8a9c1f2e-0000-4000-8000-000000000000',
    handle: 'sender',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
  },
};

const REMOTE_CARD = {
  name: 'Remote',
  description: 'Remote agent',
  url: 'http://remote.test',
  version: '0.1.0',
  protocolVersion: '0.3.0',
  capabilities: {},
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAgentCardJson', () => {
  it('resolves from the canonical agent-card.json path first', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(AGENT_CARD_PATH)) return jsonResponse(REMOTE_CARD);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { card, path } = await fetchAgentCardJson('http://remote.test/');
    expect(path).toBe(AGENT_CARD_PATH);
    expect(card).toMatchObject({ name: 'Remote' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`http://remote.test${AGENT_CARD_PATH}`);
  });

  it('falls back to the legacy agent.json path on 404', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(AGENT_CARD_PATH)) return jsonResponse({ error: 'not found' }, 404);
      if (url.endsWith(LEGACY_AGENT_CARD_PATH)) return jsonResponse(REMOTE_CARD);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { card, path } = await fetchAgentCardJson('http://remote.test');
    expect(path).toBe(LEGACY_AGENT_CARD_PATH);
    expect(card).toMatchObject({ name: 'Remote' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when the canonical path fails at the network level', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(AGENT_CARD_PATH)) throw new Error('connection refused');
      return jsonResponse(REMOTE_CARD);
    });

    const { path } = await fetchAgentCardJson('http://remote.test');
    expect(path).toBe(LEGACY_AGENT_CARD_PATH);
  });

  it('reports both attempted paths when discovery fails entirely', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));

    await expect(fetchAgentCardJson('http://remote.test')).rejects.toThrow(
      /agent-card\.json.*agent\.json/s,
    );
  });
});

describe('A2AClient', () => {
  it('discover uses canonical-then-legacy resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(AGENT_CARD_PATH)) return jsonResponse({ error: 'nope' }, 404);
      if (url.endsWith(LEGACY_AGENT_CARD_PATH)) return jsonResponse(REMOTE_CARD);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = new A2AClient(SENDER);
    const card = await client.discover('http://remote.test');
    expect(card.name).toBe('Remote');
  });

  it('sends spec-shaped kind parts on the wire', async () => {
    let sentBody: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sentBody = String(init?.body);
      return jsonResponse({
        jsonrpc: '2.0',
        id: '1',
        result: {
          id: 't1',
          contextId: 'c1',
          status: { state: 'completed', timestamp: '2026-08-20T00:00:00.000Z' },
        },
      });
    });

    const client = new A2AClient(SENDER);
    await client.sendText('http://remote.test', 'hello');

    const parsed = JSON.parse(sentBody ?? '{}') as {
      params: { message: { kind: string; parts: Array<Record<string, unknown>> } };
    };
    expect(parsed.params.message.kind).toBe('message');
    expect(parsed.params.message.parts[0]).toEqual({ kind: 'text', text: 'hello' });
  });

  it('normalizes legacy-shaped task responses, including getPosts artifacts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: '1',
        result: {
          id: 't1',
          contextId: 'c1',
          status: { state: 'completed', timestamp: '2026-08-20T00:00:00.000Z' },
          artifacts: [
            {
              name: 'posts',
              parts: [
                {
                  type: 'data',
                  data: { type: 'youagent/posts-response', posts: [{ id: 'p1' }] },
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new A2AClient(SENDER);
    const posts = await client.getPosts('http://remote.test');
    expect(posts).toEqual([{ id: 'p1' }]);
  });
});
