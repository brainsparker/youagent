import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { InMemoryTaskStore, type TaskStore } from './task-store.js';
import { SqliteTaskStore } from '../storage/sqlite-task-store.js';
import { AgentDatabase } from '../storage/database.js';
import type { Task, TaskState } from './types.js';

function makeTask(id: string, state: TaskState = 'completed', contextId = 'ctx-a'): Task {
  return {
    kind: 'task',
    id,
    contextId,
    status: { state, timestamp: '2026-09-29T12:00:00.000Z' },
    history: [{ role: 'user', messageId: `m-${id}`, parts: [{ kind: 'text', text: id }] }],
  };
}

interface Fixture {
  name: string;
  create: () => TaskStore;
  cleanup?: () => void;
}

const fixtures: Fixture[] = [
  { name: 'InMemoryTaskStore', create: () => new InMemoryTaskStore() },
  {
    name: 'SqliteTaskStore',
    create: () => new SqliteTaskStore(new Database(':memory:')),
  },
];

describe.each(fixtures)('$name contract', ({ create }) => {
  let store: TaskStore;

  beforeEach(() => {
    store = create();
  });

  it('returns undefined for unknown tasks and round-trips saved ones', () => {
    expect(store.getTask('nope')).toBeUndefined();
    const task = makeTask('t1');
    store.saveTask(task);
    expect(store.getTask('t1')).toEqual(task);
  });

  it('assigns increasing sequence numbers and keeps them on update', () => {
    const first = store.saveTask(makeTask('t1'));
    const second = store.saveTask(makeTask('t2'));
    expect(second.seq).toBeGreaterThan(first.seq);

    const updated = store.saveTask(makeTask('t1', 'working'));
    expect(updated.seq).toBe(first.seq);
    expect(store.getTask('t1')?.status.state).toBe('working');
  });

  it('lists newest first with filters, cursor pagination, and totals', () => {
    store.saveTask(makeTask('t1', 'completed', 'ctx-a'));
    store.saveTask(makeTask('t2', 'working', 'ctx-a'));
    store.saveTask(makeTask('t3', 'working', 'ctx-b'));
    store.saveTask(makeTask('t4', 'completed', 'ctx-a'));

    const all = store.listTasks({}, { limit: 10 });
    expect(all.records.map((r) => r.task.id)).toEqual(['t4', 't3', 't2', 't1']);
    expect(all.hasMore).toBe(false);
    expect(all.total).toBe(4);

    const page1 = store.listTasks({}, { limit: 2 });
    expect(page1.records.map((r) => r.task.id)).toEqual(['t4', 't3']);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(4);

    const page2 = store.listTasks({}, { limit: 2, afterSeq: page1.records[1].seq });
    expect(page2.records.map((r) => r.task.id)).toEqual(['t2', 't1']);
    expect(page2.hasMore).toBe(false);

    const ctxA = store.listTasks({ contextId: 'ctx-a' }, { limit: 10 });
    expect(ctxA.records.map((r) => r.task.id)).toEqual(['t4', 't2', 't1']);
    expect(ctxA.total).toBe(3);

    const working = store.listTasks({ status: 'working' }, { limit: 10 });
    expect(working.records.map((r) => r.task.id)).toEqual(['t3', 't2']);

    const both = store.listTasks({ contextId: 'ctx-a', status: 'working' }, { limit: 10 });
    expect(both.records.map((r) => r.task.id)).toEqual(['t2']);
    expect(both.total).toBe(1);
  });

  it('stores push configs per task in insertion order, replaces by id, and deletes', () => {
    store.saveTask(makeTask('t1'));
    expect(store.getPushConfigs('t1')).toEqual([]);

    store.savePushConfig('t1', { id: 'c1', url: 'https://hooks.example/a' });
    store.savePushConfig('t1', { id: 'c2', url: 'https://hooks.example/b', token: 'tok' });
    expect(store.getPushConfigs('t1').map((c) => c.id)).toEqual(['c1', 'c2']);

    store.savePushConfig('t1', { id: 'c1', url: 'https://hooks.example/a2' });
    expect(store.getPushConfigs('t1').find((c) => c.id === 'c1')?.url).toBe('https://hooks.example/a2');

    expect(store.deletePushConfig('t1', 'missing')).toBe(false);
    expect(store.deletePushConfig('t1', 'c1')).toBe(true);
    expect(store.getPushConfigs('t1').map((c) => c.id)).toEqual(['c2']);
    expect(store.deletePushConfig('t1', 'c1')).toBe(false);
  });
});

describe('SqliteTaskStore persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'youagent-taskstore-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps tasks, sequence numbers, and push configs across a reopen', () => {
    const path = join(dir, 'agent.db');

    const first = new Database(path);
    const storeA = new SqliteTaskStore(first);
    const seqT1 = storeA.saveTask(makeTask('t1')).seq;
    const seqT2 = storeA.saveTask(makeTask('t2', 'working')).seq;
    storeA.savePushConfig('t2', { id: 'c1', url: 'https://hooks.example/a' });
    first.close();

    const second = new Database(path);
    const storeB = new SqliteTaskStore(second);
    expect(storeB.getTask('t1')).toEqual(makeTask('t1'));
    expect(storeB.getTask('t2')?.status.state).toBe('working');
    expect(storeB.getPushConfigs('t2')).toEqual([{ id: 'c1', url: 'https://hooks.example/a' }]);

    // Sequence numbers are the pagination cursor, so they must not shift.
    const listed = storeB.listTasks({}, { limit: 10 });
    expect(listed.records.map((r) => [r.task.id, r.seq])).toEqual([
      ['t2', seqT2],
      ['t1', seqT1],
    ]);

    // New tasks continue the sequence rather than reusing numbers.
    const seqT3 = storeB.saveTask(makeTask('t3')).seq;
    expect(seqT3).toBeGreaterThan(seqT2);
    second.close();
  });

  it('shares the agent database: AgentDatabase.initialize() creates the tables', () => {
    const agentDb = new AgentDatabase(join(dir, 'youagent.db'));
    agentDb.initialize();
    const tables = agentDb
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'a2a_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['a2a_push_configs', 'a2a_tasks']);

    const store = new SqliteTaskStore(agentDb.getDb());
    store.saveTask(makeTask('t1'));
    expect(store.getTask('t1')?.id).toBe('t1');
    agentDb.close();
  });
});
