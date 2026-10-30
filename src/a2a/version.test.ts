import { describe, it, expect } from 'vitest';
import {
  A2A_DEFAULT_PROTOCOL_VERSION,
  ERROR_INFO_TYPE,
  UnsupportedProtocolVersionError,
  fromV1Part,
  fromV1PushConfig,
  fromV1PushConfigList,
  fromV1Role,
  fromV1SendMessageResult,
  fromV1TaskState,
  resolveProtocolVersion,
  toV1Error,
  toV1Message,
  toV1Part,
  toV1PushParams,
  toV1Result,
  toV1Task,
  toV1TaskState,
} from './version.js';
import { A2A_ERROR_CODES, type Message, type Task } from './types.js';

describe('resolveProtocolVersion', () => {
  it('treats a missing or empty header as 0.3 (spec 3.6.2)', () => {
    expect(resolveProtocolVersion(undefined)).toBe('0.3');
    expect(resolveProtocolVersion(null)).toBe('0.3');
    expect(resolveProtocolVersion('')).toBe('0.3');
    expect(resolveProtocolVersion('   ')).toBe('0.3');
    expect(A2A_DEFAULT_PROTOCOL_VERSION).toBe('0.3');
  });

  it('accepts 1.0 and the pre-1.0 dialect versions, ignoring patch numbers', () => {
    expect(resolveProtocolVersion('1.0')).toBe('1.0');
    expect(resolveProtocolVersion(' 1.0 ')).toBe('1.0');
    expect(resolveProtocolVersion('1.0.3')).toBe('1.0');
    expect(resolveProtocolVersion('0.3')).toBe('0.3');
    expect(resolveProtocolVersion('0.3.0')).toBe('0.3');
    expect(resolveProtocolVersion('0.2.1')).toBe('0.3');
    expect(resolveProtocolVersion('0.1')).toBe('0.3');
  });

  it('uses the first value when the header was sent more than once', () => {
    expect(resolveProtocolVersion(['1.0', '0.3'])).toBe('1.0');
  });

  it('throws UnsupportedProtocolVersionError for unknown or malformed versions', () => {
    for (const bad of ['0.5', '2.0', '1.1', 'latest', 'v1.0', '1']) {
      expect(() => resolveProtocolVersion(bad)).toThrow(UnsupportedProtocolVersionError);
    }
    try {
      resolveProtocolVersion('0.5');
    } catch (err) {
      expect((err as UnsupportedProtocolVersionError).requested).toBe('0.5');
    }
  });
});

describe('enum projections', () => {
  it('maps task states both ways', () => {
    expect(toV1TaskState('working')).toBe('TASK_STATE_WORKING');
    expect(toV1TaskState('input-required')).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(toV1TaskState('auth-required')).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(fromV1TaskState('TASK_STATE_INPUT_REQUIRED')).toBe('input-required');
    expect(fromV1TaskState('TASK_STATE_CANCELED')).toBe('canceled');
    expect(fromV1TaskState('completed')).toBe('completed');
  });

  it('maps roles both ways and leaves unknown strings alone', () => {
    expect(fromV1Role('ROLE_USER')).toBe('user');
    expect(fromV1Role('ROLE_AGENT')).toBe('agent');
    expect(fromV1Role('agent')).toBe('agent');
    expect(fromV1Role('ROLE_UNSPECIFIED')).toBe('ROLE_UNSPECIFIED');
  });
});

describe('part projections', () => {
  it('projects kind parts onto the v1.0 oneof shape', () => {
    expect(toV1Part({ kind: 'text', text: 'hi', metadata: { m: 1 } })).toEqual({ text: 'hi', metadata: { m: 1 } });
    expect(toV1Part({ kind: 'data', data: { a: 1 } })).toEqual({ data: { a: 1 } });
    expect(
      toV1Part({ kind: 'file', file: { uri: 'https://x.test/a.png', name: 'a.png', mimeType: 'image/png' } }),
    ).toEqual({ url: 'https://x.test/a.png', filename: 'a.png', mediaType: 'image/png' });
    expect(toV1Part({ kind: 'file', file: { bytes: 'aGk=', mimeType: 'text/plain' } })).toEqual({
      raw: 'aGk=',
      mediaType: 'text/plain',
    });
  });

  it('round-trips through fromV1Part', () => {
    const parts = [
      { kind: 'text', text: 'hi' },
      { kind: 'data', data: { a: [1, 2] } },
      { kind: 'file', file: { uri: 'https://x.test/a', name: 'a', mimeType: 'text/plain' }, metadata: { k: 'v' } },
    ] as const;
    for (const part of parts) {
      expect(fromV1Part(toV1Part(part))).toEqual(part);
    }
  });

  it('leaves discriminated parts untouched and returns undefined for empty objects', () => {
    const kinded = { kind: 'text', text: 'x' };
    expect(fromV1Part(kinded)).toBe(kinded);
    const legacy = { type: 'text', text: 'x' };
    expect(fromV1Part(legacy)).toBe(legacy);
    expect(fromV1Part({ metadata: {} })).toBeUndefined();
  });
});

describe('message and task projections', () => {
  const message: Message = {
    kind: 'message',
    role: 'agent',
    messageId: 'm1',
    contextId: 'c1',
    taskId: 't1',
    parts: [{ kind: 'text', text: 'done' }],
  };
  const task: Task = {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: { state: 'input-required', timestamp: '2026-10-30T00:00:00Z', message },
    history: [{ kind: 'message', role: 'user', messageId: 'm0', parts: [{ kind: 'text', text: 'go' }] }, message],
    artifacts: [{ artifactId: 'a1', parts: [{ kind: 'data', data: { ok: true } }] }],
  };

  it('drops object discriminators and rewrites enums and parts', () => {
    expect(toV1Message(message)).toEqual({
      role: 'ROLE_AGENT',
      messageId: 'm1',
      contextId: 'c1',
      taskId: 't1',
      parts: [{ text: 'done' }],
    });
    const v1 = toV1Task(task);
    expect(v1).not.toHaveProperty('kind');
    expect(v1.status).toMatchObject({ state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT' } });
    expect(v1.history).toEqual([
      { role: 'ROLE_USER', messageId: 'm0', parts: [{ text: 'go' }] },
      { role: 'ROLE_AGENT', messageId: 'm1', contextId: 'c1', taskId: 't1', parts: [{ text: 'done' }] },
    ]);
    expect(v1.artifacts).toEqual([{ artifactId: 'a1', parts: [{ data: { ok: true } }] }]);
  });

  it('omits history and artifacts when the task has none', () => {
    const bare = toV1Task({ id: 't2', contextId: 'c2', status: { state: 'completed', timestamp: 'now' } });
    expect(bare).toEqual({ id: 't2', contextId: 'c2', status: { state: 'TASK_STATE_COMPLETED', timestamp: 'now' } });
  });

  it('wraps SendMessage results and projects the task-returning methods', () => {
    expect(toV1Result('message/send', task)).toEqual({ task: toV1Task(task) });
    expect(toV1Result('message/send', message)).toEqual({ message: toV1Message(message) });
    expect(toV1Result('tasks/get', task)).toEqual(toV1Task(task));
    expect(toV1Result('tasks/cancel', task)).toEqual(toV1Task(task));
    expect(toV1Result('tasks/list', { tasks: [task], nextPageToken: '', pageSize: 50, totalSize: 1 })).toEqual({
      tasks: [toV1Task(task)],
      nextPageToken: '',
      pageSize: 50,
      totalSize: 1,
    });
    // Custom handler results are left alone.
    expect(toV1Result('message/send', { hello: 'world' })).toEqual({ hello: 'world' });
    expect(toV1Result('custom/method', task)).toBe(task);
  });

  it('unwraps SendMessageResponse on the way in', () => {
    expect(fromV1SendMessageResult({ task: { id: 't' } })).toEqual({ id: 't' });
    expect(fromV1SendMessageResult({ message: { messageId: 'm' } })).toEqual({ messageId: 'm' });
    expect(fromV1SendMessageResult({ id: 't' })).toEqual({ id: 't' });
    expect(fromV1SendMessageResult(null)).toBeNull();
  });
});

describe('error projection', () => {
  it('turns free-form error data into a google.rpc.ErrorInfo detail', () => {
    const err = toV1Error({ code: A2A_ERROR_CODES.TASK_NOT_FOUND, message: 'Task not found' });
    expect(err).toEqual({
      code: -32001,
      message: 'Task not found',
      data: [{ '@type': ERROR_INFO_TYPE, reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' }],
    });

    const withData = toV1Error({ code: -32602, message: 'bad', data: { field: 'id', count: 2 } });
    expect(withData.data).toEqual([
      { '@type': ERROR_INFO_TYPE, reason: 'INVALID_PARAMS', domain: 'a2a-protocol.org', metadata: { field: 'id', count: '2' } },
    ]);

    const withString = toV1Error({ code: -32603, message: 'boom', data: 'stack' });
    expect((withString.data as Array<{ metadata: unknown }>)[0].metadata).toEqual({ details: 'stack' });
  });

  it('passes through data that is already a typed detail array', () => {
    const data = [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [] }];
    expect(toV1Error({ code: -32602, message: 'bad', data }).data).toBe(data);
  });
});

describe('push config shapes', () => {
  it('flattens set params and renames the task/config ids for get, list and delete', () => {
    expect(
      toV1PushParams('tasks/pushNotificationConfig/set', {
        taskId: 't1',
        pushNotificationConfig: { id: 'c1', url: 'https://h.test', token: 'tok' },
      }),
    ).toEqual({ taskId: 't1', id: 'c1', url: 'https://h.test', token: 'tok' });
    expect(toV1PushParams('tasks/pushNotificationConfig/get', { id: 't1', pushNotificationConfigId: 'c1' })).toEqual({
      taskId: 't1',
      id: 'c1',
    });
    expect(toV1PushParams('tasks/pushNotificationConfig/list', { id: 't1' })).toEqual({ taskId: 't1' });
    expect(toV1PushParams('tasks/pushNotificationConfig/delete', { id: 't1', pushNotificationConfigId: 'c1' })).toEqual(
      { taskId: 't1', id: 'c1' },
    );
    expect(toV1PushParams('tasks/get', { id: 't1' })).toEqual({ id: 't1' });
  });

  it('nests flattened configs and unwraps list results', () => {
    expect(fromV1PushConfig({ taskId: 't1', id: 'c1', url: 'https://h.test' })).toEqual({
      taskId: 't1',
      pushNotificationConfig: { id: 'c1', url: 'https://h.test' },
    });
    const nested = { taskId: 't1', pushNotificationConfig: { id: 'c1', url: 'https://h.test' } };
    expect(fromV1PushConfig(nested)).toBe(nested);
    expect(fromV1PushConfigList({ configs: [{ taskId: 't1', id: 'c1', url: 'u' }], nextPageToken: '' })).toEqual([
      { taskId: 't1', pushNotificationConfig: { id: 'c1', url: 'u' } },
    ]);
    expect(fromV1PushConfigList([nested])).toEqual([nested]);
    expect(fromV1PushConfigList(null)).toEqual([]);
  });
});
