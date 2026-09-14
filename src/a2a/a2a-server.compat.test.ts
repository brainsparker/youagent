import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { A2AServer } from './a2a-server.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { AgentCard } from '../types/agent-card.js';
import type { JsonRpcResponse, Task } from './types.js';
import type { Post } from '../types/post.js';

function card(): AgentCard {
  return createAgentCard({
    handle: 'compat-test',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
  }) as AgentCard;
}

function post(): Post {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    agentId: '22222222-2222-4222-8222-222222222222',
    type: 'finding',
    summary: 'a finding',
    sourceUrls: ['https://example.test/1'],
    sourceAttribution: 'example.test',
    relevanceTags: ['testing'],
    timestamp: new Date().toISOString(),
  } as Post;
}

async function withServer(
  fn: (rpc: (method: string, params?: unknown) => Promise<JsonRpcResponse>, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server = new A2AServer({ agentCard: card(), port: 0 });
  server.registerYouAgentHandlers({
    onFollow: async (d) => { seen.push(d.handle); },
    onPostsRequest: async () => [post()],
  });
  await server.start();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = async (method: string, params?: unknown): Promise<JsonRpcResponse> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()) as JsonRpcResponse;
  };
  try {
    await fn(rpc, seen);
  } finally {
    await server.stop();
  }
}

describe('A2A wire-format compatibility on the server', () => {
  it('routes a legacy type-discriminated DataPart from a pre-0.2 peer', async () => {
    await withServer(async (rpc, seen) => {
      const res = await rpc('message/send', {
        message: {
          role: 'user',
          messageId: 'm1',
          parts: [{ type: 'data', data: { type: 'youagent/follow', agentId: 'a1', handle: 'legacybot' } }],
        },
      });
      expect(res.error).toBeUndefined();
      expect(seen).toEqual(['legacybot']);
    });
  });

  it('routes a spec kind-discriminated DataPart', async () => {
    await withServer(async (rpc, seen) => {
      const res = await rpc('message/send', {
        message: {
          role: 'user',
          messageId: 'm2',
          parts: [{ kind: 'data', data: { type: 'youagent/follow', agentId: 'a2', handle: 'specbot' } }],
        },
      });
      expect(res.error).toBeUndefined();
      expect(seen).toEqual(['specbot']);
    });
  });

  it('emits spec-shaped tasks: kind discriminators, artifactId, no legacy type on parts', async () => {
    await withServer(async (rpc) => {
      const res = await rpc('message/send', {
        message: {
          role: 'user',
          messageId: 'm3',
          parts: [{ type: 'data', data: { type: 'youagent/posts-request', limit: 5 } }],
        },
      });
      const task = res.result as Task;
      expect(task.kind).toBe('task');
      const artifact = task.artifacts?.[0];
      expect(artifact?.artifactId).toEqual(expect.any(String));
      expect(artifact?.artifactId).not.toBe('');
      expect(artifact?.parts[0].kind).toBe('data');
      expect((artifact?.parts[0] as unknown as Record<string, unknown>).type).toBeUndefined();
    });
  });

  it('rejects a part with no discriminator as invalid params', async () => {
    await withServer(async (rpc) => {
      const res = await rpc('message/send', {
        message: { role: 'user', messageId: 'm4', parts: [{ text: 'no discriminator' }] },
      });
      expect(res.error?.code).toBe(-32602);
      expect(res.error?.message).toMatch(/unknown kind/);
    });
  });
});
