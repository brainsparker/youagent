import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { A2AServer, statusUpdateEvent } from './a2a-server.js';
import { A2AClient } from './a2a-client.js';
import { parseSseStream } from './sse.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { AgentCard } from '../types/agent-card.js';
import {
  A2A_ERROR_CODES,
  type JsonRpcResponse,
  type Message,
  type StreamEvent,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from './types.js';

function makeCard(streaming = true): AgentCard {
  return createAgentCard({
    handle: 'stream-test',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
    capabilities: { streaming },
  }) as AgentCard;
}

function textMessage(text: string, extra: Partial<Message> = {}): Message {
  return {
    role: 'user',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    parts: [{ kind: 'text', text }],
    ...extra,
  };
}

async function startServer(server: A2AServer): Promise<string> {
  await server.start();
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

/** POST a JSON-RPC request and return the raw Response (SSE or JSON). */
async function post(url: string, method: string, params?: unknown, id: string | number = 'req-1'): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

/** Drain an SSE response into the JSON-RPC responses it carried. */
async function drain(res: Response): Promise<JsonRpcResponse[]> {
  const out: JsonRpcResponse[] = [];
  for await (const event of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
    out.push(JSON.parse(event.data) as JsonRpcResponse);
  }
  return out;
}

/** Wait until a predicate holds, polling, so tests do not depend on timers. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('A2AServer streaming (message/stream, tasks/resubscribe)', () => {
  let server: A2AServer;
  let url: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(), port: 0, streaming: { heartbeatMs: 0 } });
    server.registerYouAgentHandlers({
      onMessage: async (message) => ({
        role: 'agent',
        messageId: `reply-${message.messageId}`,
        parts: [{ kind: 'text', text: 'ack' }],
      }),
    });
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('answers message/stream with an SSE response: the Task, then a final status update', async () => {
    const res = await post(url, 'message/stream', { message: textMessage('hello') }, 42);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const events = await drain(res);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.jsonrpc === '2.0' && e.id === 42 && e.error === undefined)).toBe(true);

    const task = events[0].result as Task;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.status.message?.parts[0]).toEqual({ kind: 'text', text: 'ack' });

    const final = events[1].result as TaskStatusUpdateEvent;
    expect(final).toEqual(statusUpdateEvent(task, true));
    expect(final.kind).toBe('status-update');
    expect(final.final).toBe(true);
    expect(final.taskId).toBe(task.id);
    expect(final.contextId).toBe(task.contextId);
  });

  it('accepts the 1.0 alias SendStreamingMessage', async () => {
    const res = await post(url, 'SendStreamingMessage', { message: textMessage('v1') });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events = await drain(res);
    expect((events[0].result as Task).status.state).toBe('completed');
  });

  it('returns validation errors as plain JSON-RPC before opening a stream', async () => {
    const res = await post(url, 'message/stream', { nope: true });
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);

    const ghost = await post(url, 'tasks/resubscribe', { id: 'ghost' });
    expect(ghost.headers.get('content-type')).toBe('application/json');
    expect(((await ghost.json()) as JsonRpcResponse).error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('keeps the stream open for a long-running task and relays status and artifact updates in order', async () => {
    // A handler that leaves the task in `working` so the embedder can drive it.
    server.onMethod('message/send', async (params) => {
      const { message } = params as { message: Message };
      return server.openTask({ ...message, taskId: 'long-1' }, 'working');
    });

    const res = await post(url, 'message/stream', { message: textMessage('work') });
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const received: StreamEvent[] = [];
    const reading = (async () => {
      for await (const event of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
        received.push((JSON.parse(event.data) as JsonRpcResponse).result as StreamEvent);
      }
    })();

    await until(() => received.length === 1);
    expect(server.openStreamCount).toBe(1);
    expect((received[0] as Task).status.state).toBe('working');

    server.addArtifact('long-1', { name: 'partial', parts: [{ kind: 'text', text: 'chunk 1' }] });
    server.addArtifact(
      'long-1',
      { artifactId: 'art-2', parts: [{ kind: 'text', text: 'a' }] },
    );
    server.addArtifact(
      'long-1',
      { artifactId: 'art-2', parts: [{ kind: 'text', text: 'b' }] },
      { append: true, lastChunk: true },
    );
    server.setTaskStatus('long-1', 'completed', {
      role: 'agent',
      messageId: 'done',
      parts: [{ kind: 'text', text: 'finished' }],
    });

    await reading;
    expect(received.map((e) => (e as { kind?: string }).kind)).toEqual([
      'task',
      'artifact-update',
      'artifact-update',
      'artifact-update',
      'status-update',
    ]);

    const first = received[1] as TaskArtifactUpdateEvent;
    expect(first.artifact.name).toBe('partial');
    expect(typeof first.artifact.artifactId).toBe('string');
    expect(first.append).toBeUndefined();

    const appended = received[3] as TaskArtifactUpdateEvent;
    expect(appended.artifact.artifactId).toBe('art-2');
    expect(appended.append).toBe(true);
    expect(appended.lastChunk).toBe(true);
    expect(appended.artifact.parts).toEqual([{ kind: 'text', text: 'b' }]);

    const final = received[4] as TaskStatusUpdateEvent;
    expect(final.final).toBe(true);
    expect(final.status.state).toBe('completed');
    expect(final.status.message?.parts[0]).toEqual({ kind: 'text', text: 'finished' });

    // The task store merged the appended chunk and the stream was released.
    const stored = server.getTask('long-1')!;
    expect(stored.artifacts?.map((a) => a.artifactId)).toContain('art-2');
    expect(stored.artifacts?.find((a) => a.artifactId === 'art-2')?.parts).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
    expect(server.openStreamCount).toBe(0);
  });

  it('tasks/resubscribe replays the current task and follows it to completion; SubscribeToTask is an alias', async () => {
    const created = (await (await post(url, 'message/send', { message: textMessage('start') })).json()) as JsonRpcResponse;
    const task = created.result as Task;
    // Reopen a completed task so there is something to subscribe to.
    server.setTaskStatus(task.id, 'working');

    const res = await post(url, 'SubscribeToTask', { id: task.id }, 'sub-1');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const received: JsonRpcResponse[] = [];
    const reading = (async () => {
      for await (const event of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
        received.push(JSON.parse(event.data) as JsonRpcResponse);
      }
    })();

    await until(() => received.length === 1);
    expect(received[0].id).toBe('sub-1');
    expect((received[0].result as Task).status.state).toBe('working');

    server.setTaskStatus(task.id, 'failed');
    await reading;
    expect(received).toHaveLength(2);
    const final = received[1].result as TaskStatusUpdateEvent;
    expect(final.final).toBe(true);
    expect(final.status.state).toBe('failed');
  });

  it('tasks/resubscribe on a terminal task returns the task plus a final event and closes', async () => {
    const created = (await (await post(url, 'message/send', { message: textMessage('done') })).json()) as JsonRpcResponse;
    const task = created.result as Task;
    const events = await drain(await post(url, 'tasks/resubscribe', { id: task.id }));
    expect(events).toHaveLength(2);
    expect((events[0].result as Task).id).toBe(task.id);
    expect((events[1].result as TaskStatusUpdateEvent).final).toBe(true);
    expect(server.openStreamCount).toBe(0);
  });

  it('fans one task out to several subscribers and drops a subscriber that disconnects', async () => {
    server.onMethod('message/send', async (params) => {
      const { message } = params as { message: Message };
      return server.openTask({ ...message, taskId: 'fan-1' }, 'submitted');
    });

    const a = await post(url, 'message/stream', { message: textMessage('x') });
    const b = await post(url, 'tasks/resubscribe', { id: 'fan-1' });
    const c = await post(url, 'tasks/resubscribe', { id: 'fan-1' });
    await until(() => server.openStreamCount === 3);

    // Client c walks away.
    await c.body?.cancel();
    await until(() => server.openStreamCount === 2);

    const drainA = drain(a);
    const drainB = drain(b);
    server.setTaskStatus('fan-1', 'working');
    server.setTaskStatus('fan-1', 'completed');

    const [eventsA, eventsB] = await Promise.all([drainA, drainB]);
    for (const events of [eventsA, eventsB]) {
      expect(events.map((e) => (e.result as { kind: string }).kind)).toEqual(['task', 'status-update', 'status-update']);
      expect((events[1].result as TaskStatusUpdateEvent).final).toBe(false);
      expect((events[2].result as TaskStatusUpdateEvent).final).toBe(true);
    }
    expect(server.openStreamCount).toBe(0);
  });

  it('a follow-up message/send on a streamed task is relayed as a status update', async () => {
    server.onMethod('message/send', async (params) => {
      const { message } = params as { message: Message };
      const id = message.taskId ?? 'follow-1';
      // First message opens the task and waits for input; the follow-up completes it.
      return server.openTask({ ...message, taskId: id }, server.getTask(id) ? 'completed' : 'input-required');
    });

    const res = await post(url, 'message/stream', { message: textMessage('q') });
    const received: StreamEvent[] = [];
    const reading = (async () => {
      for await (const event of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
        received.push((JSON.parse(event.data) as JsonRpcResponse).result as StreamEvent);
      }
    })();
    await until(() => received.length === 1);
    expect((received[0] as Task).status.state).toBe('input-required');

    const followUp = await (await post(url, 'message/send', { message: textMessage('answer', { taskId: 'follow-1' }) })).json();
    expect((followUp as JsonRpcResponse).error).toBeUndefined();
    await reading;
    const final = received[received.length - 1] as TaskStatusUpdateEvent;
    expect(final.kind).toBe('status-update');
    expect(final.final).toBe(true);
    expect(final.status.state).toBe('completed');
  });

  it('sends SSE comment heartbeats on idle streams', async () => {
    await server.stop();
    server = new A2AServer({ agentCard: makeCard(), port: 0, streaming: { heartbeatMs: 20 } });
    server.onMethod('message/send', async (params) => {
      const { message } = params as { message: Message };
      return server.openTask({ ...message, taskId: 'hb-1' }, 'working');
    });
    url = await startServer(server);

    const res = await post(url, 'message/stream', { message: textMessage('idle') });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const deadline = Date.now() + 1500;
    while (!raw.includes(': keep-alive') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    expect(raw).toContain(': keep-alive\n\n');
    reader.releaseLock();
    server.setTaskStatus('hb-1', 'completed');
    await res.body?.cancel().catch(() => undefined);
  });

  it('stop() ends open streams so shutdown does not hang on idle connections', async () => {
    server.onMethod('message/send', async (params) => {
      const { message } = params as { message: Message };
      return server.openTask({ ...message, taskId: 'stop-1' }, 'working');
    });
    const res = await post(url, 'message/stream', { message: textMessage('bye') });
    await until(() => server.openStreamCount === 1);
    const drained = drain(res);
    await server.stop();
    const events = await drained;
    expect(events).toHaveLength(1);
    expect(server.openStreamCount).toBe(0);
    // afterEach stops again; make that a no-op by restarting on a fresh port.
    server = new A2AServer({ agentCard: makeCard(), port: 0 });
    await server.start();
  });
});

describe('A2AServer streaming disabled', () => {
  it('keeps answering streaming methods with UnsupportedOperation when the card says streaming: false', async () => {
    const server = new A2AServer({ agentCard: makeCard(false), port: 0 });
    const url = await startServer(server);
    try {
      expect(server.streamingEnabled).toBe(false);
      const res = await post(url, 'message/stream', { message: textMessage('x') });
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(((await res.json()) as JsonRpcResponse).error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
    } finally {
      await server.stop();
    }
  });

  it('streaming.enabled overrides the card flag in both directions', async () => {
    const on = new A2AServer({ agentCard: makeCard(false), port: 0, streaming: { enabled: true } });
    expect(on.streamingEnabled).toBe(true);
    const off = new A2AServer({ agentCard: makeCard(true), port: 0, streaming: { enabled: false } });
    expect(off.streamingEnabled).toBe(false);
  });
});

describe('A2AClient streaming', () => {
  let server: A2AServer;
  let url: string;
  const client = new A2AClient(makeCard());

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(), port: 0, streaming: { heartbeatMs: 0 } });
    server.registerYouAgentHandlers({
      onMessage: async () => ({ role: 'agent', messageId: 'r', parts: [{ type: 'text', text: 'legacy part' } as never] }),
    });
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('streamText yields the Task then the final status update, with parts normalized', async () => {
    const events: StreamEvent[] = [];
    for await (const event of client.streamText(url, 'hi')) events.push(event);
    expect(events).toHaveLength(2);
    const task = events[0] as Task;
    expect(task.kind).toBe('task');
    expect(task.status.message?.parts[0]).toEqual({ kind: 'text', text: 'legacy part' });
    const final = events[1] as TaskStatusUpdateEvent;
    expect(final.final).toBe(true);
    expect(final.status.message?.parts[0]).toEqual({ kind: 'text', text: 'legacy part' });
  });

  it('subscribeToTask follows a task driven by the embedder and stops on abort', async () => {
    const task = await client.sendText(url, 'start');
    server.setTaskStatus(task.id, 'working');

    const seen: StreamEvent[] = [];
    const controller = new AbortController();
    const consuming = (async () => {
      for await (const event of client.subscribeToTask(url, task.id, { signal: controller.signal })) {
        seen.push(event);
        if (seen.length === 2) controller.abort();
      }
    })();

    await until(() => server.openStreamCount === 1);
    server.setTaskStatus(task.id, 'working');
    await expect(consuming).rejects.toThrow();
    expect(seen).toHaveLength(2);
    await until(() => server.openStreamCount === 0);
    // The task is still running server-side; the abort only closed our connection.
    expect(server.getTask(task.id)?.status.state).toBe('working');
  });

  it('throws the JSON-RPC error when the agent does not stream', async () => {
    const plain = new A2AServer({ agentCard: makeCard(false), port: 0 });
    const plainUrl = await startServer(plain);
    try {
      const iterator = client.streamText(plainUrl, 'x');
      await expect(iterator.next()).rejects.toThrow(/not supported/);
    } finally {
      await plain.stop();
    }
  });
});
