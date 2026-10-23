import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { A2AServer, SSE_CONTENT_TYPE, toStreamResponse } from './a2a-server.js';
import { A2AClient, readSseData } from './a2a-client.js';
import { normalizeMessage, normalizeStreamEvent } from './compat.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { AgentCard } from '../types/agent-card.js';
import {
  A2A_ERROR_CODES,
  isTaskArtifactUpdateEvent,
  isTaskEvent,
  isTaskStatusUpdateEvent,
  type JsonRpcResponse,
  type Message,
  type MessageSendParams,
  type StreamEvent,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from './types.js';

function makeCard(streaming: boolean): AgentCard {
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

async function post(url: string, method: string, params?: unknown, id: string | number = 'req-1'): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function rpc(url: string, method: string, params?: unknown): Promise<JsonRpcResponse> {
  return (await (await post(url, method, params)).json()) as JsonRpcResponse;
}

/** Read every SSE frame of a response as parsed JSON-RPC responses. */
async function readFrames(res: Response): Promise<JsonRpcResponse[]> {
  const frames: JsonRpcResponse[] = [];
  for await (const data of readSseData(res.body!)) {
    frames.push(JSON.parse(data) as JsonRpcResponse);
  }
  return frames;
}

/** Make the server open every task in `working` so tests can drive its lifecycle. */
function registerWorkingHandler(server: A2AServer): void {
  server.onMethod('message/send', async (params: unknown) => {
    const { message } = params as MessageSendParams;
    return server.createTask(normalizeMessage(message), 'working');
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('A2AServer streaming capability gate', () => {
  it('refuses message/stream and SubscribeToTask with UnsupportedOperation when the card does not stream', async () => {
    const server = new A2AServer({ agentCard: makeCard(false), port: 0 });
    server.registerYouAgentHandlers({});
    const url = await startServer(server);
    try {
      const stream = await post(url, 'message/stream', { message: textMessage('x') });
      expect(stream.headers.get('content-type')).toBe('application/json');
      const body = (await stream.json()) as JsonRpcResponse;
      expect(body.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);

      const subscribe = await rpc(url, 'SubscribeToTask', { id: 'x' });
      expect(subscribe.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
      expect(server.streamingEnabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('lets streaming.enabled override the card flag', async () => {
    const server = new A2AServer({ agentCard: makeCard(false), port: 0, streaming: { enabled: true } });
    server.registerYouAgentHandlers({});
    const url = await startServer(server);
    try {
      expect(server.streamingEnabled).toBe(true);
      const res = await post(url, 'message/stream', { message: textMessage('hi') });
      expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
      const frames = await readFrames(res);
      expect(frames).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

describe('A2AServer message/stream', () => {
  let server: A2AServer;
  let url: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0, streaming: { keepAliveMs: 0 } });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('streams a completed task as a single SSE frame and closes', async () => {
    const res = await post(url, 'message/stream', { message: textMessage('hello') }, 7);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');

    const frames = await readFrames(res);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(7);
    const task = frames[0].result as Task;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(server.openStreamCount()).toBe(0);
  });

  it('returns ordinary JSON-RPC errors before the stream opens', async () => {
    const bad = await post(url, 'message/stream', { message: { role: 'user', messageId: 'm', parts: [{ text: 'x' }] } });
    expect(bad.headers.get('content-type')).toBe('application/json');
    expect(((await bad.json()) as JsonRpcResponse).error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);

    const ghost = await rpc(url, 'message/stream', { message: textMessage('x', { taskId: 'ghost' }) });
    expect(ghost.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('follows a working task through artifact chunks to a final status update', async () => {
    registerWorkingHandler(server);
    const client = new A2AClient(makeCard(true));
    const events: StreamEvent[] = [];

    for await (const event of client.sendMessageStream(url, [{ kind: 'text', text: 'write a report' }])) {
      events.push(event);
      if (isTaskEvent(event)) {
        expect(event.status.state).toBe('working');
        expect(server.openStreamCount(event.id)).toBe(1);
        // Drive the task from the embedder side while the stream is open.
        server.addTaskArtifact(event.id, { artifactId: 'report', name: 'report', parts: [{ kind: 'text', text: '# Report\n' }] });
        server.addTaskArtifact(
          event.id,
          { artifactId: 'report', parts: [{ kind: 'text', text: 'Body.' }] },
          { append: true, lastChunk: true },
        );
        server.setTaskStatus(event.id, 'completed', {
          role: 'agent',
          messageId: 'reply-1',
          parts: [{ kind: 'text', text: 'done' }],
        });
      }
    }

    expect(events.map((e) => (e as { kind?: string }).kind)).toEqual([
      'task',
      'artifact-update',
      'artifact-update',
      'status-update',
    ]);
    const task = events[0] as Task;
    const first = events[1] as TaskArtifactUpdateEvent;
    const second = events[2] as TaskArtifactUpdateEvent;
    const final = events[3] as TaskStatusUpdateEvent;

    expect(first.taskId).toBe(task.id);
    expect(first.contextId).toBe(task.contextId);
    expect(first.artifact.artifactId).toBe('report');
    expect(first.append).toBeUndefined();
    expect(second.append).toBe(true);
    expect(second.lastChunk).toBe(true);
    expect(second.artifact.parts).toEqual([{ kind: 'text', text: 'Body.' }]);
    expect(final.final).toBe(true);
    expect(final.status.state).toBe('completed');
    expect(final.status.message?.messageId).toBe('reply-1');

    // The stream closed and the task store holds the merged artifact.
    expect(server.openStreamCount()).toBe(0);
    const stored = server.getTask(task.id)!;
    expect(stored.artifacts).toHaveLength(1);
    expect(stored.artifacts?.[0].parts.map((p) => (p as { text: string }).text)).toEqual(['# Report\n', 'Body.']);
    expect(stored.artifacts?.[0].name).toBe('report');
  });

  it('wraps events in a 1.0 StreamResponse for SendStreamingMessage callers', async () => {
    registerWorkingHandler(server);
    const res = await post(url, 'SendStreamingMessage', { message: textMessage('v1') });
    expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);

    const frames: StreamResponse[] = [];
    for await (const data of readSseData(res.body!)) {
      const frame = (JSON.parse(data) as JsonRpcResponse).result as StreamResponse;
      frames.push(frame);
      if (frame.task) {
        server.addTaskArtifact(frame.task.id, { parts: [{ kind: 'text', text: 'chunk' }] });
        server.setTaskStatus(frame.task.id, 'completed');
      }
    }

    expect(frames).toHaveLength(3);
    expect(frames[0].task?.kind).toBe('task');
    expect(frames[1].artifactUpdate?.artifact.parts).toEqual([{ kind: 'text', text: 'chunk' }]);
    expect((frames[1].artifactUpdate as unknown as Record<string, unknown>).kind).toBeUndefined();
    expect(frames[2].statusUpdate?.status.state).toBe('completed');
    expect((frames[2].statusUpdate as unknown as Record<string, unknown>).kind).toBeUndefined();
    expect((frames[2].statusUpdate as unknown as Record<string, unknown>).final).toBeUndefined();
  });

  it('streams a direct Message and closes when the handler returns a message', async () => {
    server.onMethod('message/send', async (params: unknown) => {
      const { message } = params as MessageSendParams;
      const reply: Message = {
        kind: 'message',
        role: 'agent',
        messageId: 'direct-1',
        contextId: message.contextId,
        parts: [{ kind: 'text', text: 'pong' }],
      };
      return reply;
    });
    const client = new A2AClient(makeCard(true));
    const events: StreamEvent[] = [];
    for await (const event of client.sendMessageStream(url, [{ kind: 'text', text: 'ping' }])) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect((events[0] as Message).messageId).toBe('direct-1');
    expect((events[0] as Message).kind).toBe('message');
  });

  it('notifies subscribers when a follow-up message/send lands on the streamed task', async () => {
    registerWorkingHandler(server);
    const res = await post(url, 'message/stream', { message: textMessage('start') });
    const frames: JsonRpcResponse[] = [];
    for await (const data of readSseData(res.body!)) {
      const frame = JSON.parse(data) as JsonRpcResponse;
      frames.push(frame);
      const result = frame.result as StreamEvent;
      if (isTaskEvent(result)) {
        const followUp = await rpc(url, 'message/send', { message: textMessage('more', { taskId: result.id }) });
        expect(followUp.error).toBeUndefined();
        server.setTaskStatus(result.id, 'failed');
      }
    }
    const kinds = frames.map((f) => (f.result as { kind: string }).kind);
    expect(kinds).toEqual(['task', 'status-update', 'status-update']);
    const failed = frames[2].result as TaskStatusUpdateEvent;
    expect(failed.status.state).toBe('failed');
    expect(failed.final).toBe(true);
  });

  it('drops the subscription when the client disconnects', async () => {
    registerWorkingHandler(server);
    const client = new A2AClient(makeCard(true));
    const controller = new AbortController();
    let taskId = '';

    for await (const event of client.sendMessageStream(url, [{ kind: 'text', text: 'x' }], undefined, {
      signal: controller.signal,
    })) {
      if (isTaskEvent(event)) {
        taskId = event.id;
        expect(server.openStreamCount(taskId)).toBe(1);
        break; // consumer walks away
      }
    }

    // Give the server a moment to observe the closed socket.
    for (let i = 0; i < 25 && server.openStreamCount(taskId) > 0; i++) await tick();
    expect(server.openStreamCount(taskId)).toBe(0);
    // Later updates do not throw with nobody listening.
    server.setTaskStatus(taskId, 'completed');
  });

  it('stop() ends open streams instead of hanging on them', async () => {
    registerWorkingHandler(server);
    const res = await post(url, 'message/stream', { message: textMessage('hang') });
    const reader = readSseData(res.body!);
    const first = await reader.next();
    expect(first.done).toBe(false);
    expect(server.openStreamCount()).toBe(1);

    const stopped = server.stop();
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
    expect(await Promise.race([stopped.then(() => 'stopped' as const), timeout])).toBe('stopped');
    expect((await reader.next()).done).toBe(true);

    // afterEach stops again; make that a no-op by restarting a throwaway server.
    server = new A2AServer({ agentCard: makeCard(true), port: 0 });
    await server.start();
  });
});

describe('A2AServer tasks/resubscribe', () => {
  let server: A2AServer;
  let url: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0, streaming: { keepAliveMs: 0 } });
    server.registerYouAgentHandlers({});
    registerWorkingHandler(server);
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('replays the task snapshot then streams updates until the task ends', async () => {
    const created = (await rpc(url, 'message/send', { message: textMessage('bg') })).result as Task;
    server.addTaskArtifact(created.id, { artifactId: 'early', parts: [{ kind: 'text', text: 'before subscribe' }] });

    const client = new A2AClient(makeCard(true));
    const events: StreamEvent[] = [];
    for await (const event of client.resubscribe(url, created.id)) {
      events.push(event);
      if (isTaskEvent(event)) {
        // The snapshot already carries work done before we subscribed.
        expect(event.artifacts?.[0].artifactId).toBe('early');
        server.setTaskStatus(created.id, 'input-required');
        server.setTaskStatus(created.id, 'canceled');
      }
    }

    expect(events.filter(isTaskEvent)).toHaveLength(1);
    const statuses = events.filter(isTaskStatusUpdateEvent);
    expect(statuses.map((s) => s.status.state)).toEqual(['input-required', 'canceled']);
    expect(statuses.map((s) => s.final)).toEqual([false, true]);
    expect(events.filter(isTaskArtifactUpdateEvent)).toHaveLength(0);
  });

  it('fans one task out to several subscribers, in both dialects', async () => {
    const created = (await rpc(url, 'message/send', { message: textMessage('shared') })).result as Task;
    const legacy = await post(url, 'tasks/resubscribe', { id: created.id }, 'a');
    const v1 = await post(url, 'SubscribeToTask', { id: created.id }, 'b');
    expect(server.openStreamCount(created.id)).toBe(2);

    server.setTaskStatus(created.id, 'completed');
    const [legacyFrames, v1Frames] = await Promise.all([readFrames(legacy), readFrames(v1)]);

    expect(legacyFrames.map((f) => f.id)).toEqual(['a', 'a']);
    expect((legacyFrames[1].result as TaskStatusUpdateEvent).kind).toBe('status-update');
    expect(v1Frames.map((f) => f.id)).toEqual(['b', 'b']);
    expect((v1Frames[0].result as StreamResponse).task?.id).toBe(created.id);
    expect((v1Frames[1].result as StreamResponse).statusUpdate?.status.state).toBe('completed');
    expect(server.openStreamCount(created.id)).toBe(0);
  });

  it('refuses terminal tasks with UnsupportedOperation and unknown tasks with TaskNotFound', async () => {
    const created = (await rpc(url, 'message/send', { message: textMessage('done soon') })).result as Task;
    server.setTaskStatus(created.id, 'completed');

    const terminal = await rpc(url, 'tasks/resubscribe', { id: created.id });
    expect(terminal.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);

    const missing = await rpc(url, 'SubscribeToTask', { id: 'nope' });
    expect(missing.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);

    const noParams = await rpc(url, 'tasks/resubscribe', {});
    expect(noParams.error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);

    const client = new A2AClient(makeCard(true));
    await expect(client.resubscribe(url, created.id).next()).rejects.toThrow(/tasks\/resubscribe failed/);
  });
});

describe('readSseData', () => {
  function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  async function collect(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    for await (const data of readSseData(bodyOf(chunks))) out.push(data);
    return out;
  }

  it('joins multi-line data, skips comments and other fields, and handles split chunks', async () => {
    const frames = await collect([
      ': keep-alive\n\n',
      'event: update\nid: 1\ndata: {"a":\ndata:  1}\n\n',
      'data: {"b"',
      ':2}\n\ndata: tail',
    ]);
    expect(frames).toEqual(['{"a":\n 1}', '{"b":2}', 'tail']);
  });

  it('accepts CRLF and CR line endings', async () => {
    expect(await collect(['data: one\r\n\r\ndata: two\r\rdata: three\r\n'])).toEqual(['one', 'two', 'three']);
  });
});

describe('stream event shaping', () => {
  const task: Task = {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: { state: 'working', timestamp: '2026-09-15T00:00:00.000Z' },
  };

  it('toStreamResponse wraps each 0.3 item in the matching 1.0 oneof field', () => {
    expect(toStreamResponse(task)).toEqual({ task });
    const message: Message = { kind: 'message', role: 'agent', messageId: 'm', parts: [] };
    expect(toStreamResponse(message)).toEqual({ message });
    const status: TaskStatusUpdateEvent = { kind: 'status-update', taskId: 't1', contextId: 'c1', status: task.status, final: false };
    expect(toStreamResponse(status)).toEqual({ statusUpdate: { taskId: 't1', contextId: 'c1', status: task.status } });
    const artifact: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: 't1',
      contextId: 'c1',
      artifact: { artifactId: 'a', parts: [] },
      lastChunk: true,
    };
    expect(toStreamResponse(artifact)).toEqual({
      artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { artifactId: 'a', parts: [] }, lastChunk: true },
    });
  });

  it('normalizeStreamEvent reads 1.0 wrappers, deriving final from the state', () => {
    const done = normalizeStreamEvent({
      statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' } },
    }) as TaskStatusUpdateEvent;
    expect(done.kind).toBe('status-update');
    expect(done.status.state).toBe('completed');
    expect(done.final).toBe(true);
    expect(typeof done.status.timestamp).toBe('string');

    const busy = normalizeStreamEvent({
      statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED' } },
    }) as TaskStatusUpdateEvent;
    expect(busy.status.state).toBe('input-required');
    expect(busy.final).toBe(false);

    const art = normalizeStreamEvent({
      artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { parts: [{ type: 'text', text: 'legacy part' }] }, append: true },
    }) as TaskArtifactUpdateEvent;
    expect(art.kind).toBe('artifact-update');
    expect(art.append).toBe(true);
    expect(art.artifact.parts).toEqual([{ kind: 'text', text: 'legacy part' }]);
    expect(art.artifact.artifactId).toEqual(expect.any(String));

    expect((normalizeStreamEvent({ task }) as Task).id).toBe('t1');
    expect((normalizeStreamEvent({ message: { role: 'agent', messageId: 'm', parts: [] } }) as Message).kind).toBe('message');
  });

  it('normalizeStreamEvent reads bare 0.3 events and rejects unknown shapes', () => {
    const status = normalizeStreamEvent({
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state: 'working', timestamp: 'x' },
      final: false,
    }) as TaskStatusUpdateEvent;
    expect(status.final).toBe(false);

    const undiscriminated = normalizeStreamEvent({ id: 't1', contextId: 'c1', status: { state: 'working', timestamp: 'x' } }) as Task;
    expect(undiscriminated.kind).toBe('task');

    expect(() => normalizeStreamEvent({ nonsense: true })).toThrow(/unknown shape/);
    expect(() => normalizeStreamEvent({ statusUpdate: { taskId: 't1' } })).toThrow(/contextId/);
  });
});
