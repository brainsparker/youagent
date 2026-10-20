/**
 * SQLite-backed A2A task store.
 *
 * Tasks and push notification configs live in the agent's database (the same
 * file that holds posts and follows), so a served agent picks up exactly where
 * it left off after a restart: peers can still `tasks/get` a task they created
 * yesterday, page through `tasks/list` with a token issued before the restart,
 * and their registered webhooks keep receiving status updates.
 *
 * The whole Task is stored as JSON; `context_id` and `state` are duplicated
 * into columns so the list filters run in SQL, and `seq` is the autoincrement
 * primary key so creation order (and page tokens) survive restarts.
 */

import type Database from 'better-sqlite3';
import type {
  StoredPushNotificationConfig,
  TaskListFilter,
  TaskListPage,
  TaskListResult,
  TaskRecord,
  TaskStore,
} from '../a2a/task-store.js';
import type { Task } from '../a2a/types.js';

interface TaskRow {
  seq: number;
  task_json: string;
}

interface PushConfigRow {
  config_json: string;
}

/** Idempotent DDL for the task tables. `AgentDatabase.initialize()` runs it too. */
export const A2A_TASK_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS a2a_tasks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    context_id TEXT NOT NULL,
    state TEXT NOT NULL,
    task_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context_id ON a2a_tasks (context_id);
  CREATE INDEX IF NOT EXISTS idx_a2a_tasks_state ON a2a_tasks (state);

  CREATE TABLE IF NOT EXISTS a2a_push_configs (
    task_id TEXT NOT NULL REFERENCES a2a_tasks(id) ON DELETE CASCADE,
    config_id TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (task_id, config_id)
  );
`;

export class SqliteTaskStore implements TaskStore {
  private readonly db: Database.Database;
  private readonly stmts: {
    getTask: Database.Statement;
    upsertTask: Database.Statement;
    getSeq: Database.Statement;
    getPushConfigs: Database.Statement;
    upsertPushConfig: Database.Statement;
    deletePushConfig: Database.Statement;
  };

  /**
   * @param db An open better-sqlite3 database. The task tables are created
   *   when missing, so the store also works on databases that predate them.
   */
  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(A2A_TASK_TABLES_SQL);
    this.stmts = {
      getTask: db.prepare('SELECT seq, task_json FROM a2a_tasks WHERE id = ?'),
      upsertTask: db.prepare(`
        INSERT INTO a2a_tasks (id, context_id, state, task_json)
        VALUES (@id, @contextId, @state, @taskJson)
        ON CONFLICT(id) DO UPDATE SET
          context_id = excluded.context_id,
          state = excluded.state,
          task_json = excluded.task_json,
          updated_at = datetime('now')
      `),
      getSeq: db.prepare('SELECT seq FROM a2a_tasks WHERE id = ?'),
      getPushConfigs: db.prepare(
        'SELECT config_json FROM a2a_push_configs WHERE task_id = ? ORDER BY rowid ASC',
      ),
      upsertPushConfig: db.prepare(`
        INSERT INTO a2a_push_configs (task_id, config_id, config_json)
        VALUES (@taskId, @configId, @configJson)
        ON CONFLICT(task_id, config_id) DO UPDATE SET config_json = excluded.config_json
      `),
      deletePushConfig: db.prepare(
        'DELETE FROM a2a_push_configs WHERE task_id = ? AND config_id = ?',
      ),
    };
  }

  getTask(taskId: string): Task | undefined {
    const row = this.stmts.getTask.get(taskId) as TaskRow | undefined;
    return row ? (JSON.parse(row.task_json) as Task) : undefined;
  }

  saveTask(task: Task): TaskRecord {
    this.stmts.upsertTask.run({
      id: task.id,
      contextId: task.contextId,
      state: task.status.state,
      taskJson: JSON.stringify(task),
    });
    const { seq } = this.stmts.getSeq.get(task.id) as { seq: number };
    return { task, seq };
  }

  listTasks(filter: TaskListFilter, page: TaskListPage): TaskListResult {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.contextId !== undefined) {
      where.push('context_id = ?');
      params.push(filter.contextId);
    }
    if (filter.status !== undefined) {
      where.push('state = ?');
      params.push(filter.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM a2a_tasks ${whereSql}`)
      .get(...params) as { total: number };

    const pageWhere = [...where];
    const pageParams = [...params];
    if (page.afterSeq !== undefined) {
      pageWhere.push('seq < ?');
      pageParams.push(page.afterSeq);
    }
    const pageWhereSql = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
    const limit = Math.max(1, page.limit);

    // Fetch one extra row to learn whether another page follows.
    const rows = this.db
      .prepare(`SELECT seq, task_json FROM a2a_tasks ${pageWhereSql} ORDER BY seq DESC LIMIT ?`)
      .all(...pageParams, limit + 1) as TaskRow[];

    const hasMore = rows.length > limit;
    const records = rows
      .slice(0, limit)
      .map((row) => ({ task: JSON.parse(row.task_json) as Task, seq: row.seq }));
    return { records, hasMore, total };
  }

  getPushConfigs(taskId: string): StoredPushNotificationConfig[] {
    const rows = this.stmts.getPushConfigs.all(taskId) as PushConfigRow[];
    return rows.map((row) => JSON.parse(row.config_json) as StoredPushNotificationConfig);
  }

  savePushConfig(taskId: string, config: StoredPushNotificationConfig): void {
    this.stmts.upsertPushConfig.run({
      taskId,
      configId: config.id,
      configJson: JSON.stringify(config),
    });
  }

  deletePushConfig(taskId: string, configId: string): boolean {
    return this.stmts.deletePushConfig.run(taskId, configId).changes > 0;
  }
}
