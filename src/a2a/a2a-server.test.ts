import { afterEach, describe, expect, it } from 'vitest';
import { A2AServer } from './a2a-server.js';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH } from './discovery.js';
import type { AgentCard } from '../types/agent-card.js';
import type { Task } from './types.js';

const CARD: AgentCard = {
  name: 'Test Agent',
  description: 'An agent under test',
  url: 'http://localhost:0',
  version: '0.1.0',
  protocolVersion: '0.3.0',
  preferredTransport: 'JSONRPC',
  capabilities: {},
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

let server: A2AServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

async function startServer(): Promise<string> {
  server = new A2AServer({ port: 0, agentCard: CARD });
  server.registerYouAgentHandlers({
    onPostsRequest: async () => [],
    onMessage: async (message) => ({
      kind: 'message',
      role: 'agent',
      messageId: 'reply-1',
      parts: [{ kind: 'text', text: `echo: ${message.parts.length} part(s)` }],
    }),
  });
  await server.start();
  return `http://127.0.0.1:${server.listeningPort}`;
}

describe('A2AServer agent card discovery', () => {
  it('serves the card at the canonical /.well-known/agent-card.json path', async () => {
    const base = await startServer();
    const res = await fetch(`${base}${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Test Agent', protocolVersion: '0.3.0' });
  });

  it('keeps serving the deprecated legacy /.well-known/agent.json path', async () => {
    const base = await startServer();
    const res = await fetch(`${base}${LEGACY_AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Test Agent' });
  });

  it('keeps the /agent-card convenience alias', async () => {
    const base = await startServer();
    const res = await fetch(`${base}/agent-card`);
    expect(res.status).toBe(200);
  });
});

describe('A2AServer message ingest compatibility', () => {
  async function send(base: string, parts: unknown[]): Promise<Task> {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'message/send',
        params: { message: { role: 'user', messageId: 'm1', parts } },
      }),
    });
    const body = (await res.json()) as { result?: Task; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as Task;
  }

  it('accepts spec-shaped kind parts', async () => {
    const base = await startServer();
    const task = await send(base, [{ kind: 'text', text: 'hello' }]);
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
  });

  it('accepts legacy type parts from pre-0.3 peers', async () => {
    const base = await startServer();
    const task = await send(base, [
      { type: 'data', data: { type: 'youagent/posts-request', limit: 5 } },
    ]);
    expect(task.status.state).toBe('completed');
    expect(task.artifacts).toHaveLength(1);
  });

  it('emits spec-shaped tasks: task kind, artifactId, and kind-discriminated parts', async () => {
    const base = await startServer();
    const task = await send(base, [
      { kind: 'data', data: { type: 'youagent/posts-request' } },
    ]);
    expect(task.kind).toBe('task');
    const artifact = task.artifacts?.[0];
    expect(artifact?.artifactId).toBeTruthy();
    expect(artifact?.parts[0]).toMatchObject({ kind: 'data' });
    expect(artifact?.parts[0]).not.toHaveProperty('type');
  });

  it('normalizes stored history to kind parts', async () => {
    const base = await startServer();
    const task = await send(base, [{ type: 'text', text: 'legacy hello' }]);
    expect(task.history?.[0].parts[0]).toEqual({ kind: 'text', text: 'legacy hello' });
    expect(task.history?.[0].kind).toBe('message');
  });
});
