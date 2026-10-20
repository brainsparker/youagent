import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { A2AServer } from './a2a-server.js';
import { SqliteTaskStore } from '../storage/sqlite-task-store.js';
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
    handle: 'persist-test',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
    capabilities: { pushNotifications },
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

async function rpc(url: string, method: string, params?: unknown): Promise<JsonRpcResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'req', method, params }),
  });
  return (await res.json()) as JsonRpcResponse;
}

/** A server plus the database handle it stores tasks in. */
interface Running {
  server: A2AServer;
  db: Database.Database;
  url: string;
}

async function boot(dbPath: string, pushNotifications = false): Promise<Running> {
  const db = new Database(dbPath);
  const server = new A2AServer({
    agentCard: makeCard(pushNotifications),
    port: 0,
    taskStore: new SqliteTaskStore(db),
    pushNotifications: { allowPrivateHosts: true, timeoutMs: 2000 },
  });
  server.registerYouAgentHandlers({});
  await server.start();
  const addr = server.address() as AddressInfo;
  return { server, db, url: `http://127.0.0.1:${addr.port}` };
}

async function shutdown(running: Running): Promise<void> {
  await running.server.stop();
  running.db.close();
}

describe('A2AServer with SqliteTaskStore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'youagent-a2a-persist-'));
    dbPath = join(dir, 'agent.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves tasks created before a restart, including history and follow-up rules', async () => {
    const a = await boot(dbPath);
    const created = (await rpc(a.url, 'message/send', { message: textMessage('before restart') })).result as Task;
    const working = (await rpc(a.url, 'message/send', { message: textMessage('second') })).result as Task;
    a.server.setTaskStatus(working.id, 'working');
    await shutdown(a);

    const b = await boot(dbPath);
    try {
      const fetched = (await rpc(b.url, 'tasks/get', { id: created.id })).result as Task;
      expect(fetched.id).toBe(created.id);
      expect(fetched.contextId).toBe(created.contextId);
      expect(fetched.status.state).toBe('completed');
      expect(fetched.history?.[0].parts[0]).toEqual({ kind: 'text', text: 'before restart' });

      // Terminal-state rules apply to persisted tasks too.
      const followUp = await rpc(b.url, 'message/send', {
        message: textMessage('again', { taskId: created.id }),
      });
      expect(followUp.error?.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);

      // A non-terminal task from the previous process still accepts messages and cancels.
      const continued = (await rpc(b.url, 'message/send', {
        message: textMessage('continue', { taskId: working.id }),
      })).result as Task;
      expect(continued.id).toBe(working.id);
      expect(continued.history).toHaveLength(2);
    } finally {
      await shutdown(b);
    }
  });

  it('keeps tasks/list order and honors page tokens issued before the restart', async () => {
    const a = await boot(dbPath);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const task = (await rpc(a.url, 'message/send', { message: textMessage(`task ${i}`) })).result as Task;
      ids.push(task.id);
    }
    const page1 = (await rpc(a.url, 'tasks/list', { pageSize: 2 })).result as ListTasksResult;
    expect(page1.tasks.map((t) => t.id)).toEqual([ids[4], ids[3]]);
    expect(page1.totalSize).toBe(5);
    expect(page1.nextPageToken).not.toBe('');
    await shutdown(a);

    const b = await boot(dbPath);
    try {
      const page2 = (await rpc(b.url, 'tasks/list', { pageSize: 2, pageToken: page1.nextPageToken }))
        .result as ListTasksResult;
      expect(page2.tasks.map((t) => t.id)).toEqual([ids[2], ids[1]]);
      expect(page2.totalSize).toBe(5);

      const page3 = (await rpc(b.url, 'tasks/list', { pageSize: 2, pageToken: page2.nextPageToken }))
        .result as ListTasksResult;
      expect(page3.tasks.map((t) => t.id)).toEqual([ids[0]]);
      expect(page3.nextPageToken).toBe('');

      // A task created after the restart lands at the top.
      const fresh = (await rpc(b.url, 'message/send', { message: textMessage('after restart') })).result as Task;
      const top = (await rpc(b.url, 'tasks/list', { pageSize: 1 })).result as ListTasksResult;
      expect(top.tasks[0].id).toBe(fresh.id);
      expect(top.totalSize).toBe(6);
    } finally {
      await shutdown(b);
    }
  });

  it('remembers push notification configs and delivers to them after a restart', async () => {
    const received: Task[] = [];
    const hook: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Task);
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

    const a = await boot(dbPath, true);
    const task = (await rpc(a.url, 'message/send', { message: textMessage('watch me') })).result as Task;
    a.server.setTaskStatus(task.id, 'working');
    const set = await rpc(a.url, 'tasks/pushNotificationConfig/set', {
      taskId: task.id,
      pushNotificationConfig: { url: hookUrl, token: 'secret-token' },
    });
    expect(set.error).toBeUndefined();
    const configId = (set.result as TaskPushNotificationConfig).pushNotificationConfig.id;
    await shutdown(a);

    const b = await boot(dbPath, true);
    try {
      const listed = (await rpc(b.url, 'tasks/pushNotificationConfig/list', { id: task.id }))
        .result as TaskPushNotificationConfig[];
      expect(listed).toHaveLength(1);
      expect(listed[0].pushNotificationConfig.id).toBe(configId);
      expect(listed[0].pushNotificationConfig.url).toBe(hookUrl);

      const before = received.length;
      b.server.setTaskStatus(task.id, 'completed');
      await b.server.flushPushNotifications();
      expect(received.length).toBe(before + 1);
      expect(received[received.length - 1].id).toBe(task.id);
      expect(received[received.length - 1].status.state).toBe('completed');

      const deleted = await rpc(b.url, 'tasks/pushNotificationConfig/delete', {
        id: task.id,
        pushNotificationConfigId: configId,
      });
      expect(deleted.error).toBeUndefined();
      const gone = await rpc(b.url, 'tasks/pushNotificationConfig/get', { id: task.id });
      expect(gone.error?.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    } finally {
      await shutdown(b);
      await new Promise<void>((resolve) => hook.close(() => resolve()));
    }
  });

  it('exposes the store to embedders', async () => {
    const a = await boot(dbPath);
    try {
      expect(a.server.taskStore).toBeInstanceOf(SqliteTaskStore);
      const task = (await rpc(a.url, 'message/send', { message: textMessage('hello') })).result as Task;
      expect(a.server.taskStore.getTask(task.id)?.id).toBe(task.id);
    } finally {
      await shutdown(a);
    }
  });
});
