import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { A2AServer } from './a2a-server.js';
import {
  A2A_ERROR_DOMAIN,
  A2A_ERROR_INFO_TYPE,
  A2A_REST_CONTENT_TYPE,
  matchRestRoute,
  restStatusFor,
  toRestErrorBody,
  withHttpJsonInterface,
} from './rest.js';
import { createAgentCard } from '../schema/agent-card.schema.js';
import type { AgentCard } from '../types/agent-card.js';
import { A2A_BINDING_HTTP_JSON, A2A_BINDING_JSONRPC, A2A_WELL_KNOWN_PATH } from '../types/agent-card.js';
import { A2A_ERROR_CODES, type ListTasksResult, type Message, type Task } from './types.js';

function makeCard(pushNotifications = false): AgentCard {
  return createAgentCard({
    handle: 'rest-test',
    interests: [{ topic: 'testing' }],
    cadence: '6h',
    url: 'https://rest.example.com/a2a',
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

async function startServer(server: A2AServer): Promise<string> {
  await server.start();
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

interface RestErrorShape {
  error: {
    code: number;
    status: string;
    message: string;
    details: Array<{ '@type': string; reason: string; domain: string; metadata?: unknown }>;
  };
}

async function postJson(url: string, body: unknown, contentType = A2A_REST_CONTENT_TYPE): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(body),
  });
}

async function sendText(base: string, text: string, contextId?: string): Promise<Task> {
  const res = await postJson(`${base}/message:send`, { message: textMessage(text, { contextId }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: Task };
  return body.task;
}

describe('REST route table', () => {
  it('maps every spec section 5.3 REST endpoint onto an A2A operation', () => {
    expect(matchRestRoute('POST', '/message:send')?.operation).toBe('SendMessage');
    expect(matchRestRoute('POST', '/message:stream')?.operation).toBe('SendStreamingMessage');
    expect(matchRestRoute('GET', '/tasks')?.operation).toBe('ListTasks');
    expect(matchRestRoute('GET', '/tasks/abc')).toMatchObject({ operation: 'GetTask', params: { id: 'abc' } });
    expect(matchRestRoute('POST', '/tasks/abc:cancel')).toMatchObject({ operation: 'CancelTask', params: { id: 'abc' } });
    expect(matchRestRoute('POST', '/tasks/abc:subscribe')?.operation).toBe('SubscribeToTask');
    expect(matchRestRoute('GET', '/tasks/abc:subscribe')?.operation).toBe('SubscribeToTask');
    expect(matchRestRoute('POST', '/tasks/abc/pushNotificationConfigs')?.operation).toBe(
      'CreateTaskPushNotificationConfig',
    );
    expect(matchRestRoute('GET', '/tasks/abc/pushNotificationConfigs')?.operation).toBe(
      'ListTaskPushNotificationConfigs',
    );
    expect(matchRestRoute('GET', '/tasks/abc/pushNotificationConfigs/c1')).toMatchObject({
      operation: 'GetTaskPushNotificationConfig',
      params: { id: 'abc', configId: 'c1' },
    });
    expect(matchRestRoute('DELETE', '/tasks/abc/pushNotificationConfigs/c1')?.operation).toBe(
      'DeleteTaskPushNotificationConfig',
    );
    expect(matchRestRoute('GET', '/extendedAgentCard')?.operation).toBe('GetExtendedAgentCard');
  });

  it('does not accept the pre-1.0 /v1 prefix or the wrong HTTP method', () => {
    expect(matchRestRoute('POST', '/v1/message:send')).toBeUndefined();
    expect(matchRestRoute('GET', '/message:send')).toBeUndefined();
    expect(matchRestRoute('DELETE', '/tasks/abc')).toBeUndefined();
    expect(matchRestRoute('GET', '/tasks/abc/extra')).toBeUndefined();
  });

  it('URL-decodes path parameters', () => {
    expect(matchRestRoute('GET', '/tasks/a%20b')?.params.id).toBe('a b');
  });
});

describe('REST error mapping', () => {
  it('follows the spec section 5.4 HTTP status table', () => {
    expect(restStatusFor(A2A_ERROR_CODES.TASK_NOT_FOUND)).toBe(404);
    expect(restStatusFor(A2A_ERROR_CODES.TASK_NOT_CANCELABLE)).toBe(400);
    expect(restStatusFor(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED)).toBe(400);
    expect(restStatusFor(A2A_ERROR_CODES.UNSUPPORTED_OPERATION)).toBe(400);
    expect(restStatusFor(A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED)).toBe(400);
    expect(restStatusFor(A2A_ERROR_CODES.INVALID_AGENT_RESPONSE)).toBe(500);
    expect(restStatusFor(A2A_ERROR_CODES.EXTENDED_AGENT_CARD_NOT_CONFIGURED)).toBe(400);
    expect(restStatusFor(A2A_ERROR_CODES.INVALID_PARAMS)).toBe(400);
    expect(restStatusFor(A2A_ERROR_CODES.INTERNAL_ERROR)).toBe(500);
    expect(restStatusFor(-1)).toBe(500);
  });

  it('renders google.rpc.Status with an ErrorInfo detail carrying the A2A reason', () => {
    const body = toRestErrorBody({ code: A2A_ERROR_CODES.TASK_NOT_CANCELABLE, message: 'nope', data: { taskId: 't1' } });
    expect(body).toEqual({
      error: {
        code: 400,
        status: 'FAILED_PRECONDITION',
        message: 'nope',
        details: [
          {
            '@type': A2A_ERROR_INFO_TYPE,
            reason: 'TASK_NOT_CANCELABLE',
            domain: A2A_ERROR_DOMAIN,
            metadata: { taskId: 't1' },
          },
        ],
      },
    });
  });
});

describe('withHttpJsonInterface', () => {
  it('appends an HTTP+JSON interface for each JSON-RPC interface, JSON-RPC first', () => {
    const card = withHttpJsonInterface(makeCard());
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://rest.example.com/a2a', protocolBinding: A2A_BINDING_JSONRPC, protocolVersion: '0.2.1' },
      { url: 'https://rest.example.com/a2a', protocolBinding: A2A_BINDING_HTTP_JSON, protocolVersion: '0.2.1' },
    ]);
  });

  it('is idempotent and leaves cards without a JSON-RPC interface alone', () => {
    const once = withHttpJsonInterface(makeCard());
    expect(withHttpJsonInterface(once)).toBe(once);
    const grpcOnly = { ...makeCard(), supportedInterfaces: [{ url: 'h:1', protocolBinding: 'GRPC', protocolVersion: '1.0' }] };
    expect(withHttpJsonInterface(grpcOnly)).toBe(grpcOnly);
  });
});

describe('A2AServer HTTP+JSON/REST binding', () => {
  let server: A2AServer;
  let base: string;

  beforeEach(async () => {
    server = new A2AServer({ agentCard: makeCard(true), port: 0, pushNotifications: { allowPrivateHosts: true } });
    server.registerYouAgentHandlers({
      onMessage: async (message) => ({
        role: 'agent',
        messageId: `reply-${message.messageId}`,
        parts: [{ kind: 'text', text: 'ack' }],
      }),
    });
    base = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('advertises the HTTP+JSON interface on the served card', async () => {
    const res = await fetch(`${base}${A2A_WELL_KNOWN_PATH}`);
    const card = (await res.json()) as AgentCard;
    expect(card.supportedInterfaces.map((i) => i.protocolBinding)).toEqual([A2A_BINDING_JSONRPC, A2A_BINDING_HTTP_JSON]);
    expect(card.supportedInterfaces[1].url).toBe('https://rest.example.com/a2a');
  });

  it('POST /message:send returns a SendMessageResponse wrapping the task, as application/a2a+json', async () => {
    const res = await postJson(`${base}/message:send`, { message: textMessage('hello') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(A2A_REST_CONTENT_TYPE);
    const body = (await res.json()) as { task: Task };
    expect(body.task.kind).toBe('task');
    expect(body.task.status.state).toBe('completed');
    expect(body.task.status.message?.parts[0]).toEqual({ kind: 'text', text: 'ack' });
    expect(body.task.history).toHaveLength(2);
  });

  it('accepts plain application/json request bodies too', async () => {
    const res = await postJson(`${base}/message:send`, { message: textMessage('hello') }, 'application/json');
    expect(res.status).toBe(200);
  });

  it('rejects other request content types with ContentTypeNotSupportedError', async () => {
    const res = await fetch(`${base}/message:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as RestErrorShape;
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.details[0].reason).toBe('CONTENT_TYPE_NOT_SUPPORTED');
  });

  it('reports malformed JSON and missing fields as 400 INVALID_ARGUMENT / REQUEST_MALFORMED', async () => {
    const bad = await fetch(`${base}/message:send`, {
      method: 'POST',
      headers: { 'Content-Type': A2A_REST_CONTENT_TYPE },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as RestErrorShape).error.details[0].reason).toBe('REQUEST_MALFORMED');

    const missing = await postJson(`${base}/message:send`, {});
    expect(missing.status).toBe(400);
    const body = (await missing.json()) as RestErrorShape;
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.message).toMatch(/message/);
  });

  it('GET /tasks/{id} returns the task and honors ?historyLength', async () => {
    const task = await sendText(base, 'hello');

    const full = await fetch(`${base}/tasks/${task.id}`);
    expect(full.status).toBe(200);
    expect(((await full.json()) as Task).history).toHaveLength(2);

    const trimmed = await fetch(`${base}/tasks/${task.id}?historyLength=1`);
    expect(((await trimmed.json()) as Task).history).toHaveLength(1);

    const none = await fetch(`${base}/tasks/${task.id}?historyLength=0`);
    expect(((await none.json()) as Task).history).toBeUndefined();

    const invalid = await fetch(`${base}/tasks/${task.id}?historyLength=lots`);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as RestErrorShape).error.details[0].reason).toBe('REQUEST_MALFORMED');
  });

  it('GET /tasks/{id} for an unknown task is 404 NOT_FOUND with reason TASK_NOT_FOUND', async () => {
    const res = await fetch(`${base}/tasks/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as RestErrorShape;
    expect(body.error).toMatchObject({ code: 404, status: 'NOT_FOUND' });
    expect(body.error.details[0]).toMatchObject({
      '@type': A2A_ERROR_INFO_TYPE,
      reason: 'TASK_NOT_FOUND',
      domain: A2A_ERROR_DOMAIN,
    });
  });

  it('GET /tasks lists tasks with camelCase query filters and cursor pagination', async () => {
    const ctx = 'ctx-rest';
    await sendText(base, 'one', ctx);
    await sendText(base, 'two', ctx);
    await sendText(base, 'three', 'other');

    const all = await fetch(`${base}/tasks`);
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as ListTasksResult;
    expect(allBody.totalSize).toBe(3);
    expect(allBody.nextPageToken).toBe('');

    const filtered = await fetch(`${base}/tasks?contextId=${ctx}&status=TASK_STATE_COMPLETED&pageSize=1&historyLength=0`);
    const page1 = (await filtered.json()) as ListTasksResult;
    expect(page1.totalSize).toBe(2);
    expect(page1.tasks).toHaveLength(1);
    expect(page1.tasks[0].history).toBeUndefined();
    expect(page1.nextPageToken).not.toBe('');

    const next = await fetch(`${base}/tasks?contextId=${ctx}&pageSize=1&pageToken=${encodeURIComponent(page1.nextPageToken)}`);
    const page2 = (await next.json()) as ListTasksResult;
    expect(page2.tasks).toHaveLength(1);
    expect(page2.tasks[0].id).not.toBe(page1.tasks[0].id);
    expect(page2.nextPageToken).toBe('');

    const badSize = await fetch(`${base}/tasks?pageSize=0`);
    expect(badSize.status).toBe(400);
  });

  it('POST /tasks/{id}:cancel cancels a live task and refuses a terminal one', async () => {
    const task = await sendText(base, 'hello');
    // Tasks complete synchronously here; reopen one so cancel has work to do.
    server.setTaskStatus(task.id, 'working');

    const ok = await fetch(`${base}/tasks/${task.id}:cancel`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Task).status.state).toBe('canceled');

    const again = await fetch(`${base}/tasks/${task.id}:cancel`, { method: 'POST' });
    expect(again.status).toBe(400);
    const body = (await again.json()) as RestErrorShape;
    expect(body.error.status).toBe('FAILED_PRECONDITION');
    expect(body.error.details[0].reason).toBe('TASK_NOT_CANCELABLE');
  });

  it('streaming routes answer 400 UNSUPPORTED_OPERATION while the card declares streaming: false', async () => {
    const stream = await postJson(`${base}/message:stream`, { message: textMessage('hello') });
    expect(stream.status).toBe(400);
    expect(((await stream.json()) as RestErrorShape).error.details[0].reason).toBe('UNSUPPORTED_OPERATION');

    const task = await sendText(base, 'hello');
    const sub = await fetch(`${base}/tasks/${task.id}:subscribe`, { method: 'POST' });
    expect(sub.status).toBe(400);
    expect(((await sub.json()) as RestErrorShape).error.details[0].reason).toBe('UNSUPPORTED_OPERATION');
  });

  it('GET /extendedAgentCard answers 400 EXTENDED_AGENT_CARD_NOT_CONFIGURED', async () => {
    const res = await fetch(`${base}/extendedAgentCard`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as RestErrorShape;
    expect(body.error.status).toBe('FAILED_PRECONDITION');
    expect(body.error.details[0].reason).toBe('EXTENDED_AGENT_CARD_NOT_CONFIGURED');
  });

  it('manages push notification configs as a task sub-resource in the 1.0 flattened shape', async () => {
    const task = await sendText(base, 'hello');
    const configsUrl = `${base}/tasks/${task.id}/pushNotificationConfigs`;

    const created = await postJson(configsUrl, { url: 'http://127.0.0.1:9/hook', token: 'tok' });
    expect(created.status).toBe(201);
    const config = (await created.json()) as { taskId: string; id: string; url: string; token: string };
    expect(config.taskId).toBe(task.id);
    expect(config.url).toBe('http://127.0.0.1:9/hook');
    expect(typeof config.id).toBe('string');
    expect(config).not.toHaveProperty('pushNotificationConfig');

    const listed = await fetch(configsUrl);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ configs: [config], nextPageToken: '' });

    const got = await fetch(`${configsUrl}/${config.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(config);

    const deleted = await fetch(`${configsUrl}/${config.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    const gone = await fetch(`${configsUrl}/${config.id}`);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as RestErrorShape).error.details[0].reason).toBe('TASK_NOT_FOUND');
  });

  it('the path task id wins over a conflicting taskId in the push config body', async () => {
    const task = await sendText(base, 'hello');
    const res = await postJson(`${base}/tasks/${task.id}/pushNotificationConfigs`, {
      taskId: 'someone-else',
      url: 'http://127.0.0.1:9/hook',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { taskId: string }).taskId).toBe(task.id);
  });

  it('rejects push configs for unknown tasks with 404 and for invalid webhook URLs with 400', async () => {
    const unknown = await postJson(`${base}/tasks/nope/pushNotificationConfigs`, { url: 'http://127.0.0.1:9/hook' });
    expect(unknown.status).toBe(404);

    const task = await sendText(base, 'hello');
    const bad = await postJson(`${base}/tasks/${task.id}/pushNotificationConfigs`, { url: 'ftp://example.com' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as RestErrorShape).error.status).toBe('INVALID_ARGUMENT');
  });

  it('shares one task store with the JSON-RPC binding', async () => {
    const task = await sendText(base, 'via rest');
    const rpc = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: task.id } }),
    });
    const body = (await rpc.json()) as { result: Task };
    expect(body.result.id).toBe(task.id);
  });

  it('still 404s unknown paths and the pre-1.0 /v1 prefix', async () => {
    expect((await fetch(`${base}/v1/tasks`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('A2AServer with restBinding: false', () => {
  it('serves JSON-RPC only and does not advertise HTTP+JSON', async () => {
    const server = new A2AServer({ agentCard: makeCard(), port: 0, restBinding: false });
    server.registerYouAgentHandlers({});
    const base = await startServer(server);
    try {
      const res = await postJson(`${base}/message:send`, { message: textMessage('hello') });
      expect(res.status).toBe(404);
      const card = (await (await fetch(`${base}${A2A_WELL_KNOWN_PATH}`)).json()) as AgentCard;
      expect(card.supportedInterfaces.map((i) => i.protocolBinding)).toEqual([A2A_BINDING_JSONRPC]);
    } finally {
      await server.stop();
    }
  });

  it('pushNotifications disabled: the REST config routes answer 400 PUSH_NOTIFICATION_NOT_SUPPORTED', async () => {
    const server = new A2AServer({ agentCard: makeCard(false), port: 0 });
    server.registerYouAgentHandlers({});
    const base = await startServer(server);
    try {
      const task = await sendText(base, 'hello');
      const res = await postJson(`${base}/tasks/${task.id}/pushNotificationConfigs`, { url: 'https://example.com/hook' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as RestErrorShape;
      expect(body.error.status).toBe('FAILED_PRECONDITION');
      expect(body.error.details[0].reason).toBe('PUSH_NOTIFICATION_NOT_SUPPORTED');
    } finally {
      await server.stop();
    }
  });
});
