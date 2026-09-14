import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { A2AServer, applyHistoryLength, isPrivateHost, normalizeTaskState } from './a2a-server.js';
import { A2AClient } from './a2a-client.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { AgentCard } from '../types/agent-card.js';
import {
  A2A_ERROR_CODES,
  type JsonRpcResponse,
  type ListTasksResult,
  type Message,
  type Task,
  type TaskPushNotificationConfig,
} from './types.js';

function makeCard(pushNotifications = false): AgentCard {
  return createAgentCard({
    handle: 'task-test',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
    capabilities: { pushNotifications },
  }) as AgentCard;
}

function textMessage(text: string, extra: Partial<Message> = {}): Message {
  return {
    role: 'user',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    parts: [{ type: 'text', text }],
    ...extra,
  };
}

async function startServer(server: A2AServer): Promise<string> {
  await server.start();
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function rpc(
  url: string,
  method: string,
  params?: unknown,
  id: string | number = 'req-1',
): Promise<JsonRpcResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return (await res.json()) as JsonRpcResponse;
}

async function sendText(url: string, text: string, contextId?: string): Promise<Task> {
  const res = await rpc(url, 'message/send', { message: textMessage(text, { contextId }) });
  expect(res.error).toBeUndefined();
  return res.result as Task;
}

describe('A2AServer task lifecycle', () => {
  let server: A2AServer;
  let url: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(), port: 0 });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('accepts numeric JSON-RPC ids, including 0, and echoes them back', async () => {
    const res = await rpc(url, 'message/send', { message: textMessage('hi') }, 0);
    expect(res.id).toBe(0);
    expect(res.error).toBeUndefined();
  });

  it('returns InvalidRequest with a null id when the envelope is broken', async () => {
    const raw = await fetch(url, { method: 'POST', body: JSON.stringify({ method: 'tasks/get' }) });
    const res = (await raw.json()) as JsonRpcResponse;
    expect(res.id).toBeNull();
    expect(res.error?.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('returns InvalidParams when required params are missing', async () => {
    const res = await rpc(url, 'tasks/get', {});
    expect(res.error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('honors historyLength on tasks/get', async () => {
    const task = await sendText(url, 'first');
    server.setTaskStatus(task.id, 'working', {
      role: 'agent',
      messageId: 'reply-1',
      parts: [{ type: 'text', text: 'ack' }],
    });

    const full = (await rpc(url, 'tasks/get', { id: task.id })).result as Task;
    expect(full.history).toHaveLength(2);

    const none = (await rpc(url, 'tasks/get', { id: task.id, historyLength: 0 })).result as Task;
    expect(none.history).toBeUndefined();

    const last = (await rpc(url, 'tasks/get', { id: task.id, historyLength: 1 })).result as Task;
    expect(last.history).toHaveLength(1);
    expect(last.history?.[0].messageId).toBe('reply-1');
  });

  it('rejects cancel on a terminal task with TaskNotCancelable and cancels a working one', async () => {
    const done = await sendText(url, 'done');
    const notCancelable = await rpc(url, 'tasks/cancel', { id: done.id });
    expect(notCancelable.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_CANCELABLE);

    const busy = await sendText(url, 'busy');
    server.setTaskStatus(busy.id, 'working');
    const canceled = (await rpc(url, 'tasks/cancel', { id: busy.id })).result as Task;
    expect(canceled.status.state).toBe('canceled');

    const missing = await rpc(url, 'tasks/cancel', { id: 'nope' });
    expect(missing.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('refuses follow-up messages to unknown or terminal tasks', async () => {
    const unknown = await rpc(url, 'message/send', { message: textMessage('x', { taskId: 'ghost' }) });
    expect(unknown.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);

    const done = await sendText(url, 'done');
    const terminal = await rpc(url, 'message/send', { message: textMessage('more', { taskId: done.id }) });
    expect(terminal.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
  });

  it('answers streaming methods with UnsupportedOperation, not MethodNotFound', async () => {
    const stream = await rpc(url, 'message/stream', { message: textMessage('x') });
    expect(stream.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
    const subscribe = await rpc(url, 'SubscribeToTask', { id: 'x' });
    expect(subscribe.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
    const unknown = await rpc(url, 'tasks/frobnicate', {});
    expect(unknown.error?.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });

  describe('tasks/list', () => {
    it('lists newest first with totalSize and an empty nextPageToken on the last page', async () => {
      const a = await sendText(url, 'a');
      const b = await sendText(url, 'b');
      const c = await sendText(url, 'c');

      const result = (await rpc(url, 'tasks/list', {})).result as ListTasksResult;
      expect(result.tasks.map((t) => t.id)).toEqual([c.id, b.id, a.id]);
      expect(result.totalSize).toBe(3);
      expect(result.pageSize).toBe(50);
      expect(result.nextPageToken).toBe('');
    });

    it('filters by contextId and by status in both 0.3 and 1.0 spellings', async () => {
      const shared = 'ctx-shared';
      const a = await sendText(url, 'a', shared);
      await sendText(url, 'b', shared);
      const other = await sendText(url, 'c', 'ctx-other');
      server.setTaskStatus(a.id, 'input-required');

      const byContext = (await rpc(url, 'tasks/list', { contextId: shared })).result as ListTasksResult;
      expect(byContext.totalSize).toBe(2);
      expect(byContext.tasks.every((t) => t.contextId === shared)).toBe(true);

      const byStatus = (await rpc(url, 'tasks/list', { status: 'input-required' })).result as ListTasksResult;
      expect(byStatus.tasks.map((t) => t.id)).toEqual([a.id]);

      const byV1Status = (await rpc(url, 'ListTasks', { status: 'TASK_STATE_INPUT_REQUIRED' }))
        .result as ListTasksResult;
      expect(byV1Status.tasks.map((t) => t.id)).toEqual([a.id]);

      const completed = (await rpc(url, 'tasks/list', { status: 'TASK_STATE_COMPLETED', contextId: 'ctx-other' }))
        .result as ListTasksResult;
      expect(completed.tasks.map((t) => t.id)).toEqual([other.id]);

      const bad = await rpc(url, 'tasks/list', { status: 'TASK_STATE_BOGUS' });
      expect(bad.error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });

    it('pages with cursor tokens without duplicates or gaps, even as new tasks arrive', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await sendText(url, `t${i}`)).id);
      }

      const seen: string[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const page = (await rpc(url, 'tasks/list', { pageSize: 2, pageToken: token })).result as ListTasksResult;
        expect(page.pageSize).toBe(2);
        expect(page.totalSize).toBeGreaterThanOrEqual(5);
        seen.push(...page.tasks.map((t) => t.id));
        token = page.nextPageToken || undefined;
        pages++;
        // A task created mid-pagination must not disturb later pages.
        if (pages === 1) await sendText(url, 'late');
      } while (token);

      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it('applies historyLength per task and validates paging params', async () => {
      await sendText(url, 'a');
      const noHistory = (await rpc(url, 'tasks/list', { historyLength: 0 })).result as ListTasksResult;
      expect(noHistory.tasks[0].history).toBeUndefined();

      const clamped = (await rpc(url, 'tasks/list', { pageSize: 500 })).result as ListTasksResult;
      expect(clamped.pageSize).toBe(100);

      expect((await rpc(url, 'tasks/list', { pageSize: 0 })).error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
      expect((await rpc(url, 'tasks/list', { pageToken: 'garbage' })).error?.code).toBe(
        A2A_ERROR_CODES.INVALID_PARAMS,
      );
    });

    it('is reachable from the A2AClient and through the 1.0 GetTask alias', async () => {
      const task = await sendText(url, 'a');
      const client = new A2AClient(makeCard());
      const listed = await client.listTasks(url, { pageSize: 10 });
      expect(listed.tasks.map((t) => t.id)).toEqual([task.id]);

      const viaAlias = (await rpc(url, 'GetTask', { id: task.id })).result as Task;
      expect(viaAlias.id).toBe(task.id);
    });
  });
});

describe('A2AServer push notification configs', () => {
  let server: A2AServer;
  let url: string;

  afterEach(async () => {
    await server.stop();
  });

  it('returns PushNotificationNotSupported when the card does not declare the capability', async () => {
    server = new A2AServer({ agentCard: makeCard(false), port: 0 });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
    const task = await sendText(url, 'a');

    const res = await rpc(url, 'tasks/pushNotificationConfig/set', {
      taskId: task.id,
      pushNotificationConfig: { url: 'https://hooks.example.com/a2a' },
    });
    expect(res.error?.code).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED);
    expect(server.pushNotificationsEnabled).toBe(false);
  });

  it('sets, lists, gets and deletes configs in the 0.3 wire shape', async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0 });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
    const task = await sendText(url, 'a');

    const set = (
      await rpc(url, 'tasks/pushNotificationConfig/set', {
        taskId: task.id,
        pushNotificationConfig: { url: 'https://hooks.example.com/a2a', token: 't-1' },
      })
    ).result as TaskPushNotificationConfig;
    expect(set.taskId).toBe(task.id);
    expect(set.pushNotificationConfig.url).toBe('https://hooks.example.com/a2a');
    expect(typeof set.pushNotificationConfig.id).toBe('string');

    const listed = (await rpc(url, 'tasks/pushNotificationConfig/list', { id: task.id }))
      .result as TaskPushNotificationConfig[];
    expect(listed).toHaveLength(1);

    const got = (
      await rpc(url, 'tasks/pushNotificationConfig/get', {
        id: task.id,
        pushNotificationConfigId: set.pushNotificationConfig.id,
      })
    ).result as TaskPushNotificationConfig;
    expect(got.pushNotificationConfig.token).toBe('t-1');

    const first = (await rpc(url, 'tasks/pushNotificationConfig/get', { id: task.id }))
      .result as TaskPushNotificationConfig;
    expect(first.pushNotificationConfig.id).toBe(set.pushNotificationConfig.id);

    const deleted = await rpc(url, 'tasks/pushNotificationConfig/delete', {
      id: task.id,
      pushNotificationConfigId: set.pushNotificationConfig.id,
    });
    expect(deleted.result).toBeNull();

    const after = await rpc(url, 'tasks/pushNotificationConfig/get', { id: task.id });
    expect(after.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);

    const unknownTask = await rpc(url, 'tasks/pushNotificationConfig/list', { id: 'ghost' });
    expect(unknownTask.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('speaks the 1.0 PascalCase methods with the flattened shape', async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0 });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
    const task = (await rpc(url, 'SendMessage', { message: textMessage('a') })).result as Task;

    const created = (
      await rpc(url, 'CreateTaskPushNotificationConfig', {
        taskId: task.id,
        id: 'cfg-1',
        url: 'https://hooks.example.com/a2a',
        authentication: { schemes: ['Bearer'], credentials: 'secret' },
      })
    ).result as Record<string, unknown>;
    expect(created.id).toBe('cfg-1');
    expect(created.taskId).toBe(task.id);
    expect(created.url).toBe('https://hooks.example.com/a2a');
    expect(created.pushNotificationConfig).toBeUndefined();

    const listed = (await rpc(url, 'ListTaskPushNotificationConfigs', { taskId: task.id })).result as {
      configs: Array<Record<string, unknown>>;
      nextPageToken: string;
    };
    expect(listed.configs).toHaveLength(1);
    expect(listed.nextPageToken).toBe('');

    const got = (await rpc(url, 'GetTaskPushNotificationConfig', { taskId: task.id, id: 'cfg-1' }))
      .result as Record<string, unknown>;
    expect(got.id).toBe('cfg-1');

    const deleted = await rpc(url, 'DeleteTaskPushNotificationConfig', { taskId: task.id, id: 'cfg-1' });
    expect(deleted.error).toBeUndefined();
    const after = (await rpc(url, 'ListTaskPushNotificationConfigs', { taskId: task.id })).result as {
      configs: unknown[];
    };
    expect(after.configs).toHaveLength(0);
  });

  it('rejects non-http schemes and private hosts unless explicitly allowed', async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0 });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
    const task = await sendText(url, 'a');

    for (const bad of ['ftp://hooks.example.com/x', 'not a url', 'http://127.0.0.1:9/x', 'http://[::1]/x', 'http://10.1.2.3/x']) {
      const res = await rpc(url, 'tasks/pushNotificationConfig/set', {
        taskId: task.id,
        pushNotificationConfig: { url: bad },
      });
      expect(res.error?.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    }
    await server.stop();

    server = new A2AServer({
      agentCard: makeCard(true),
      port: 0,
      pushNotifications: { allowPrivateHosts: true },
    });
    server.registerYouAgentHandlers({});
    url = await startServer(server);
    const local = await sendText(url, 'a');
    const ok = await rpc(url, 'tasks/pushNotificationConfig/set', {
      taskId: local.id,
      pushNotificationConfig: { url: 'http://127.0.0.1:9/x' },
    });
    expect(ok.error).toBeUndefined();
  });

  it('delivers the task to the webhook with token and bearer headers on status changes', async () => {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: Task }> = [];
    const receiver: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Task });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

    const failures: unknown[] = [];
    server = new A2AServer({
      agentCard: makeCard(true),
      port: 0,
      pushNotifications: { allowPrivateHosts: true, onDeliveryError: (err) => failures.push(err) },
    });
    server.registerYouAgentHandlers({});
    url = await startServer(server);

    try {
      const task = await sendText(url, 'long job');
      const client = new A2AClient(makeCard());
      const cfg = await client.setPushNotificationConfig(url, task.id, {
        url: hookUrl,
        token: 'tok-123',
        authentication: { schemes: ['Bearer'], credentials: 'bearer-abc' },
      });
      expect(cfg.pushNotificationConfig.id).toBeDefined();

      server.setTaskStatus(task.id, 'working');
      server.setTaskStatus(task.id, 'completed');
      await server.flushPushNotifications();

      expect(failures).toHaveLength(0);
      expect(received).toHaveLength(2);
      expect(received[0].body.id).toBe(task.id);
      expect(received[0].body.status.state).toBe('working');
      expect(received[1].body.status.state).toBe('completed');
      expect(received[0].headers['x-a2a-notification-token']).toBe('tok-123');
      expect(received[0].headers['authorization']).toBe('Bearer bearer-abc');
      expect(received[0].headers['content-type']).toBe('application/json');

      const configs = await client.listPushNotificationConfigs(url, task.id);
      expect(configs).toHaveLength(1);
      await client.deletePushNotificationConfig(url, task.id, cfg.pushNotificationConfig.id as string);
      expect(await client.listPushNotificationConfigs(url, task.id)).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  it('reports delivery failures through onDeliveryError without throwing', async () => {
    const failures: unknown[] = [];
    server = new A2AServer({
      agentCard: makeCard(true),
      port: 0,
      pushNotifications: {
        allowPrivateHosts: true,
        onDeliveryError: (err) => failures.push(err),
        fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      },
    });
    server.registerYouAgentHandlers({});
    url = await startServer(server);

    const task = await sendText(url, 'a');
    await rpc(url, 'tasks/pushNotificationConfig/set', {
      taskId: task.id,
      pushNotificationConfig: { url: 'http://127.0.0.1:9/hook' },
    });
    server.setTaskStatus(task.id, 'working');
    await server.flushPushNotifications();
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/HTTP 500/);
  });
});

describe('A2A helpers', () => {
  it('normalizes 1.0 task state names', () => {
    expect(normalizeTaskState('TASK_STATE_WORKING')).toBe('working');
    expect(normalizeTaskState('TASK_STATE_INPUT_REQUIRED')).toBe('input-required');
    expect(normalizeTaskState('canceled')).toBe('canceled');
    expect(() => normalizeTaskState('TASK_STATE_NOPE')).toThrow();
  });

  it('applies historyLength semantics', () => {
    const task: Task = {
      id: 't',
      contextId: 'c',
      status: { state: 'working', timestamp: 'now' },
      history: [textMessage('1'), textMessage('2'), textMessage('3')],
    };
    expect(applyHistoryLength(task, undefined).history).toHaveLength(3);
    expect(applyHistoryLength(task, 0).history).toBeUndefined();
    expect(applyHistoryLength(task, 2).history?.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['2', '3']);
  });

  it('classifies private hosts', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '::1', '[::1]', 'fd00::1']) {
      expect(isPrivateHost(host)).toBe(true);
    }
    for (const host of ['hooks.example.com', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateHost(host)).toBe(false);
    }
  });

  it('classifies IPv4-mapped IPv6 loopback as private', () => {
    // new URL() canonicalizes [::ffff:127.0.0.1] to ::ffff:7f00:1, which
    // still reaches loopback, so the mapped form has to be unpacked.
    for (const raw of ['http://[::ffff:127.0.0.1]/hook', 'http://[::ffff:10.0.0.5]/hook', 'http://[::ffff:192.168.1.1]/hook']) {
      expect(isPrivateHost(new URL(raw).hostname)).toBe(true);
    }
    expect(isPrivateHost(new URL('http://[::ffff:8.8.8.8]/hook').hostname)).toBe(false);
  });

  it('rejects a webhook that hides loopback behind an IPv4-mapped IPv6 literal', async () => {
    const server = new A2AServer({ agentCard: makeCard(true), port: 0 });
    server.registerYouAgentHandlers({});
    const url = await startServer(server);
    try {
      const task = await sendText(url, 'a');
      const res = await rpc(url, 'tasks/pushNotificationConfig/set', {
        taskId: task.id,
        pushNotificationConfig: { url: 'http://[::ffff:127.0.0.1]:9/hook' },
      });
      expect(res.error?.message).toMatch(/loopback or private-network/);
    } finally {
      await server.stop();
    }
  });
});
