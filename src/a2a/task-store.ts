/**
 * Task store: where an A2AServer keeps its tasks and push notification
 * configs.
 *
 * The server used to hold both in private Maps, so a restart forgot every
 * task a peer had created and every webhook a peer had registered. The store
 * is now pluggable: `InMemoryTaskStore` keeps the old behavior (and stays the
 * default for embedders that construct an A2AServer directly), while
 * `SqliteTaskStore` in the storage layer persists everything in the agent's
 * SQLite database. This mirrors the TaskStore / PushNotificationConfigStore
 * split in the reference A2A SDKs.
 *
 * Stores are synchronous on purpose: better-sqlite3 is synchronous, and a
 * synchronous contract keeps the server's request handling free of
 * interleaving between a read and the write that depends on it.
 */

import type { PushNotificationConfig, Task, TaskState } from './types.js';

/** A task together with its monotonic creation sequence number. */
export interface TaskRecord {
  task: Task;
  /**
   * Creation order, starting at 1 and never reused. `tasks/list` sorts by it
   * (newest first) and encodes it in page tokens, so it must be stable across
   * restarts for a persistent store.
   */
  seq: number;
}

/** Filters accepted by {@link TaskStore.listTasks}. */
export interface TaskListFilter {
  /** Only tasks from this conversation. */
  contextId?: string;
  /** Only tasks in this (normalized, lowercase) state. */
  status?: TaskState;
}

/** Cursor pagination for {@link TaskStore.listTasks}. */
export interface TaskListPage {
  /** Return only records with a sequence number strictly below this one. */
  afterSeq?: number;
  /** Maximum number of records to return. At least 1. */
  limit: number;
}

/** One page of a task listing. */
export interface TaskListResult {
  /** Matching records, newest first, at most `limit` of them. */
  records: TaskRecord[];
  /** Whether more records follow the last one returned. */
  hasMore: boolean;
  /** Matching records before pagination (ignores `afterSeq`). */
  total: number;
}

/** A push notification config as stored: the id is always assigned. */
export type StoredPushNotificationConfig = PushNotificationConfig & { id: string };

/**
 * Persistence contract for A2A tasks and push notification configs.
 *
 * Implementations own the sequence numbering: the first `saveTask` for a task
 * id assigns the next sequence number, later saves keep it.
 */
export interface TaskStore {
  /** Look up a task by id, or undefined when unknown. */
  getTask(taskId: string): Task | undefined;
  /** Insert or replace a task. Returns the stored record with its sequence number. */
  saveTask(task: Task): TaskRecord;
  /** List tasks newest first with optional filters and cursor pagination. */
  listTasks(filter: TaskListFilter, page: TaskListPage): TaskListResult;
  /** All push notification configs registered for a task, in insertion order. */
  getPushConfigs(taskId: string): StoredPushNotificationConfig[];
  /** Insert or replace a push notification config for a task (keyed by config id). */
  savePushConfig(taskId: string, config: StoredPushNotificationConfig): void;
  /** Remove one push notification config. Returns false when it did not exist. */
  deletePushConfig(taskId: string, configId: string): boolean;
}

/**
 * The default store: everything lives in process memory and is gone when the
 * process exits. Suitable for tests, examples, and embedders that manage
 * their own persistence.
 */
export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, Task>();
  private seqById = new Map<string, number>();
  private nextSeq = 1;
  /** taskId -> configId -> config */
  private pushConfigs = new Map<string, Map<string, StoredPushNotificationConfig>>();

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  saveTask(task: Task): TaskRecord {
    this.tasks.set(task.id, task);
    let seq = this.seqById.get(task.id);
    if (seq === undefined) {
      seq = this.nextSeq++;
      this.seqById.set(task.id, seq);
    }
    return { task, seq };
  }

  listTasks(filter: TaskListFilter, page: TaskListPage): TaskListResult {
    const matching = [...this.tasks.values()]
      .filter((t) => filter.contextId === undefined || t.contextId === filter.contextId)
      .filter((t) => filter.status === undefined || t.status.state === filter.status)
      .map((task) => ({ task, seq: this.seqById.get(task.id) ?? 0 }))
      .sort((a, b) => b.seq - a.seq);

    const remaining =
      page.afterSeq === undefined ? matching : matching.filter((r) => r.seq < (page.afterSeq as number));
    const records = remaining.slice(0, Math.max(1, page.limit));
    return { records, hasMore: remaining.length > records.length, total: matching.length };
  }

  getPushConfigs(taskId: string): StoredPushNotificationConfig[] {
    return [...(this.pushConfigs.get(taskId)?.values() ?? [])];
  }

  savePushConfig(taskId: string, config: StoredPushNotificationConfig): void {
    let byId = this.pushConfigs.get(taskId);
    if (!byId) {
      byId = new Map();
      this.pushConfigs.set(taskId, byId);
    }
    byId.set(config.id, config);
  }

  deletePushConfig(taskId: string, configId: string): boolean {
    const byId = this.pushConfigs.get(taskId);
    if (!byId?.delete(configId)) return false;
    if (byId.size === 0) this.pushConfigs.delete(taskId);
    return true;
  }
}
