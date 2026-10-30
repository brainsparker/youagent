import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { A2AServer } from './a2a-server.js';
import { A2AClient } from './a2a-client.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { AgentCard } from '../types/agent-card.js';
import { A2A_ERROR_CODES, type JsonRpcResponse, type Task } from './types.js';
import { A2A_VERSION_HEADER, ERROR_INFO_TYPE } from './version.js';

function makeCard(pushNotifications = false): AgentCard {
  return createAgentCard({
    handle: 'version-test',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
    capabilities: { pushNotifications },
  }) as AgentCard;
}

async function startServer(server: A2AServer): Promise<string> {
  await server.start();
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

interface RpcCall {
  status: number;
  headers: Headers;
  body: JsonRpcResponse;
}

async function rpc(
  url: string,
  method: string,
  params?: unknown,
  version?: string,
  id: string | number = 'req-1',
): Promise<RpcCall> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (version !== undefined) headers[A2A_VERSION_HEADER] = version;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as JsonRpcResponse };
}

const v1TextMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  role: 'ROLE_USER',
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  parts: [{ text }],
  ...extra,
});

describe('A2A-Version negotiation', () => {
  let server: A2AServer;
  let url: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0, pushNotifications: { allowPrivateHosts: true } });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('answers in the 0.3 dialect when the header is absent, and says so', async () => {
    const res = await rpc(url, 'message/send', {
      message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'hi' }] },
    });
    expect(res.body.error).toBeUndefined();
    const task = res.body.result as Task;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.history?.[0].role).toBe('user');
    expect(res.headers.get(A2A_VERSION_HEADER.toLowerCase())).toBe('0.3');
    expect(res.headers.get('vary')).toBe(A2A_VERSION_HEADER);
  });

  it('treats 0.3 and the pre-0.3 versions youagent used to advertise as the 0.3 dialect', async () => {
    for (const version of ['0.3', '0.2.1', '0.1']) {
      const res = await rpc(url, 'tasks/list', {}, version);
      expect(res.body.error).toBeUndefined();
      expect(res.headers.get(A2A_VERSION_HEADER.toLowerCase())).toBe('0.3');
    }
  });

  it('speaks the v1.0 dialect end to end when the client sends A2A-Version: 1.0', async () => {
    const sent = await rpc(url, 'SendMessage', { message: v1TextMessage('hello') }, '1.0');
    expect(sent.status).toBe(200);
    expect(sent.headers.get(A2A_VERSION_HEADER.toLowerCase())).toBe('1.0');
    expect(sent.body.error).toBeUndefined();

    // SendMessageResponse is a oneof wrapper; the task has no `kind`, uses
    // TASK_STATE_* and ROLE_*, and parts are the oneof shape.
    const wrapped = sent.body.result as { task: Record<string, unknown> };
    expect(Object.keys(wrapped)).toEqual(['task']);
    const task = wrapped.task;
    expect(task).not.toHaveProperty('kind');
    expect((task.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    const history = task.history as Array<Record<string, unknown>>;
    expect(history[0].role).toBe('ROLE_USER');
    expect(history[0]).not.toHaveProperty('kind');
    expect(history[0].parts).toEqual([{ text: 'hello' }]);

    // GetTask, ListTasks and CancelTask follow the same dialect.
    const got = await rpc(url, 'GetTask', { id: task.id }, '1.0');
    expect((got.body.result as Record<string, unknown>).status).toMatchObject({ state: 'TASK_STATE_COMPLETED' });

    const listed = await rpc(url, 'ListTasks', { status: 'TASK_STATE_COMPLETED' }, '1.0');
    const list = listed.body.result as { tasks: Array<Record<string, unknown>>; totalSize: number };
    expect(list.totalSize).toBe(1);
    expect((list.tasks[0].status as { state: string }).state).toBe('TASK_STATE_COMPLETED');

    const canceled = await rpc(url, 'CancelTask', { id: task.id }, '1.0');
    expect(canceled.body.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_CANCELABLE);
  });

  it('stores one internal shape regardless of the dialect a task was created in', async () => {
    const sent = await rpc(url, 'SendMessage', { message: v1TextMessage('from v1') }, '1.0');
    const id = (sent.body.result as { task: { id: string } }).task.id;

    // Same task read back by a 0.3 client comes out in 0.3 shapes.
    const legacy = (await rpc(url, 'tasks/get', { id })).body.result as Task;
    expect(legacy.kind).toBe('task');
    expect(legacy.status.state).toBe('completed');
    expect(legacy.history?.[0]).toMatchObject({ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'from v1' }] });

    // And the embedder API sees the stored 0.3 shape.
    expect(server.getTask(id)?.status.state).toBe('completed');
  });

  it('accepts the 0.3 method names under A2A-Version: 1.0 and still answers in 1.0', async () => {
    const res = await rpc(url, 'message/send', { message: v1TextMessage('alias') }, '1.0');
    expect(res.body.error).toBeUndefined();
    expect(res.body.result).toHaveProperty('task');
  });

  it('also reads the version from the ?A2A-Version= query parameter', async () => {
    const res = await rpc(`${url}/?A2A-Version=1.0`, 'tasks/list', {});
    expect(res.headers.get(A2A_VERSION_HEADER.toLowerCase())).toBe('1.0');
    expect(res.body.error).toBeUndefined();
  });

  it('returns VersionNotSupportedError (-32009) with typed details for unknown versions', async () => {
    const res = await rpc(url, 'tasks/list', {}, '0.5', 42);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    expect(res.body.error?.code).toBe(A2A_ERROR_CODES.VERSION_NOT_SUPPORTED);
    expect(res.body.error?.code).toBe(-32009);
    expect(res.body.error?.message).toMatch(/0\.5/);
    const details = res.body.error?.data as Array<Record<string, unknown>>;
    expect(details[0]['@type']).toBe(ERROR_INFO_TYPE);
    expect(details[0].reason).toBe('VERSION_NOT_SUPPORTED');
    expect(details[0].metadata).toEqual({ requestedVersion: '0.5', supportedVersions: '1.0,0.3' });
    // The response advertises the newest version the server speaks.
    expect(res.headers.get(A2A_VERSION_HEADER.toLowerCase())).toBe('1.0');

    const malformed = await rpc(url, 'tasks/list', {}, 'latest');
    expect(malformed.body.error?.code).toBe(-32009);
  });

  it('projects errors onto error.data typed details in the 1.0 dialect only', async () => {
    const v1 = await rpc(url, 'GetTask', { id: 'ghost' }, '1.0');
    expect(v1.body.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    expect(v1.body.error?.data).toEqual([
      { '@type': ERROR_INFO_TYPE, reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' },
    ]);

    const legacy = await rpc(url, 'tasks/get', { id: 'ghost' });
    expect(legacy.body.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    expect(legacy.body.error?.data).toBeUndefined();

    const unknown = await rpc(url, 'NoSuchMethod', {}, '1.0');
    expect(unknown.body.error?.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    expect((unknown.body.error?.data as Array<{ reason: string }>)[0].reason).toBe('METHOD_NOT_FOUND');
  });

  it('shapes push notification configs by negotiated version, not only by method name', async () => {
    const sent = await rpc(url, 'SendMessage', { message: v1TextMessage('job') }, '1.0');
    const taskId = (sent.body.result as { task: { id: string } }).task.id;

    // 0.3 method name, but 1.0 negotiated: flattened shape and wrapped list.
    const created = await rpc(
      url,
      'tasks/pushNotificationConfig/set',
      { taskId, pushNotificationConfig: { id: 'cfg-1', url: 'http://127.0.0.1:9/hook' } },
      '1.0',
    );
    expect(created.body.result).toEqual({ taskId, id: 'cfg-1', url: 'http://127.0.0.1:9/hook' });

    const listed = await rpc(url, 'tasks/pushNotificationConfig/list', { id: taskId }, '1.0');
    expect(listed.body.result).toEqual({ configs: [{ taskId, id: 'cfg-1', url: 'http://127.0.0.1:9/hook' }], nextPageToken: '' });

    const deleted = await rpc(url, 'tasks/pushNotificationConfig/delete', { id: taskId, pushNotificationConfigId: 'cfg-1' }, '1.0');
    expect(deleted.body.result).toEqual({});
  });
});

describe('push notification payload dialect', () => {
  it('delivers a StreamResponse as application/a2a+json to 1.0 subscribers and a bare Task to 0.3 subscribers', async () => {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
    const receiver: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;

    const server = new A2AServer({
      agentCard: makeCard(true),
      port: 0,
      pushNotifications: { allowPrivateHosts: true },
    });
    server.registerYouAgentHandlers({});
    const url = await startServer(server);

    try {
      const sent = await rpc(url, 'message/send', {
        message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'job' }] },
      });
      const taskId = (sent.body.result as Task).id;

      await rpc(url, 'tasks/pushNotificationConfig/set', {
        taskId,
        pushNotificationConfig: { id: 'legacy', url: `http://127.0.0.1:${port}/legacy` },
      });
      await rpc(url, 'CreateTaskPushNotificationConfig', { taskId, id: 'modern', url: `http://127.0.0.1:${port}/v1` }, '1.0');

      server.setTaskStatus(taskId, 'working');
      await server.flushPushNotifications();

      expect(received).toHaveLength(2);
      const legacy = received.find((r) => !('task' in r.body));
      const modern = received.find((r) => 'task' in r.body);
      expect(legacy).toBeDefined();
      expect(modern).toBeDefined();

      expect(legacy!.headers['content-type']).toBe('application/json');
      expect(legacy!.headers['a2a-version']).toBe('0.3');
      expect(legacy!.body).toMatchObject({ kind: 'task', id: taskId, status: { state: 'working' } });

      expect(modern!.headers['content-type']).toBe('application/a2a+json');
      expect(modern!.headers['a2a-version']).toBe('1.0');
      const task = modern!.body.task as Record<string, unknown>;
      expect(task).not.toHaveProperty('kind');
      expect(task.id).toBe(taskId);
      expect(task.status).toMatchObject({ state: 'TASK_STATE_WORKING' });
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});

describe('A2AClient protocol version', () => {
  let server: A2AServer;
  let url: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0, pushNotifications: { allowPrivateHosts: true } });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('sends A2A-Version: 0.3 by default', async () => {
    const seen: string[] = [];
    const probe = createServer((req, res) => {
      seen.push(String(req.headers['a2a-version']));
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { tasks: [], nextPageToken: '', pageSize: 50, totalSize: 0 } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    try {
      const client = new A2AClient(makeCard());
      expect(client.protocolVersion).toBe('0.3');
      await client.listTasks(`http://127.0.0.1:${(probe.address() as AddressInfo).port}`);
      expect(seen).toEqual(['0.3']);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('speaks 1.0 on the wire when configured and still returns the internal shapes', async () => {
    const client = new A2AClient(makeCard(), { protocolVersion: '1.0' });
    expect(client.protocolVersion).toBe('1.0');

    const task = await client.sendText(url, 'hello from a 1.0 client');
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.history?.[0]).toMatchObject({ role: 'user', parts: [{ kind: 'text', text: 'hello from a 1.0 client' }] });

    // What actually went over the wire was the 1.0 request shape.
    const stored = server.getTask(task.id);
    expect(stored?.history?.[0].role).toBe('user');

    const fetched = await client.getTask(url, task.id);
    expect(fetched.status.state).toBe('completed');

    const listed = await client.listTasks(url);
    expect(listed.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(listed.tasks[0].status.state).toBe('completed');

    const cfg = await client.setPushNotificationConfig(url, task.id, { id: 'c1', url: 'http://127.0.0.1:9/hook' });
    expect(cfg).toEqual({ taskId: task.id, pushNotificationConfig: { id: 'c1', url: 'http://127.0.0.1:9/hook' } });
    expect(await client.getPushNotificationConfig(url, task.id, 'c1')).toEqual(cfg);
    expect(await client.listPushNotificationConfigs(url, task.id)).toEqual([cfg]);
    await client.deletePushNotificationConfig(url, task.id, 'c1');
    expect(await client.listPushNotificationConfigs(url, task.id)).toEqual([]);
  });

  it('sends the 1.0 request shape: PascalCase method, ROLE_USER, oneof parts', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const probe = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        requests.push({ ...parsed, version: req.headers['a2a-version'] });
        const result = {
          task: {
            id: 't1',
            contextId: 'c1',
            status: { state: 'TASK_STATE_COMPLETED', timestamp: 'now' },
            history: [{ role: 'ROLE_USER', messageId: 'm', parts: [{ text: 'ping' }] }],
          },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    try {
      const client = new A2AClient(makeCard(), { protocolVersion: '1.0' });
      const task = await client.sendText(`http://127.0.0.1:${(probe.address() as AddressInfo).port}`, 'ping');

      expect(requests).toHaveLength(1);
      expect(requests[0].version).toBe('1.0');
      expect(requests[0].method).toBe('SendMessage');
      const message = (requests[0].params as { message: Record<string, unknown> }).message;
      expect(message.role).toBe('ROLE_USER');
      expect(message).not.toHaveProperty('kind');
      expect(message.parts).toEqual([{ text: 'ping' }]);

      // The 1.0 response was unwrapped and normalized to the internal shape.
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('completed');
      expect(task.history?.[0]).toMatchObject({ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'ping' }] });
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
});
