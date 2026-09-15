/**
 * A2A server: JSON-RPC 2.0 based agent-to-agent message handling.
 *
 * Implements the A2A task lifecycle surface: message/send, tasks/get,
 * tasks/list, tasks/cancel and the four tasks/pushNotificationConfig methods,
 * reachable under both the 0.3 method names and the 1.0 PascalCase aliases.
 * When the card declares `capabilities.streaming`, message/stream and
 * tasks/resubscribe answer with a Server-Sent Events stream of task updates.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import {
  A2A_CARD_MEDIA_TYPE,
  A2A_LEGACY_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
  getAgentIdentifier,
  getAgentUrl,
} from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import { normalizeMessage } from './compat.js';
import {
  ATOM_CONTENT_TYPE,
  DEFAULT_FEED_LIMIT,
  JSON_FEED_CONTENT_TYPE,
  parseFeedLimit,
  renderAtomFeed,
  renderJsonFeed,
  type FeedOptions,
} from '../feed/feed.js';
import {
  A2A_ERROR_CODES,
  A2A_V1_METHOD_ALIASES,
  isTerminalTaskState,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcId,
  type Message,
  type Task,
  type TaskState,
  type TaskStatus,
  type Artifact,
  type DataPart,
  type MessageSendParams,
  type TaskQueryParams,
  type TaskIdParams,
  type ListTasksParams,
  type ListTasksResult,
  type PushNotificationConfig,
  type TaskPushNotificationConfig,
  type StreamEvent,
  type StreamResponse,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
  type YouAgentFollowData,
  type YouAgentUnfollowData,
  type YouAgentPostsRequestData,
  type YouAgentPostsResponseData,
} from './types.js';

/** Handler function for an A2A JSON-RPC method. */
export type A2AMethodHandler = (params: unknown, request: JsonRpcRequest) => Promise<unknown>;

/**
 * Syndication feed configuration. When present, the server also answers
 * GET /feed.xml (Atom 1.0) and GET /feed.json (JSON Feed 1.1) with the
 * agent's posts, so feed readers and other web clients can follow the agent
 * without speaking A2A.
 */
export interface A2AFeedConfig {
  /**
   * Return the posts to syndicate, newest first. `limit` is the bounded
   * value of the request's `?limit=` query (default 50, max 500).
   */
  getPosts: (limit: number) => Promise<Post[]> | Post[];
  /** Feed title. Defaults to `@handle`. */
  title?: string;
  /** Feed description. Defaults to the agent card description. */
  description?: string;
  /** Default number of posts when no `?limit=` is given. Defaults to 50. */
  defaultLimit?: number;
  /**
   * Public base URL used for the feed's self link (for example when the
   * server sits behind a reverse proxy). Defaults to the agent card `url`.
   */
  publicUrl?: string;
}

/** Push notification (webhook) delivery options. */
export interface PushNotificationOptions {
  /**
   * Whether push notification configs are accepted. Defaults to the card's
   * capabilities.pushNotifications flag, which is what clients read.
   */
  enabled?: boolean;
  /** Per-delivery timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /**
   * Allow webhook URLs that resolve to loopback or private-network hosts.
   * Off by default so a remote caller cannot point the agent at internal
   * services. Turn on for local development and tests.
   */
  allowPrivateHosts?: boolean;
  /** Called when a delivery attempt fails. Delivery is best-effort and never throws. */
  onDeliveryError?: (error: unknown, config: TaskPushNotificationConfig) => void;
  /** fetch implementation override (tests, custom agents). */
  fetch?: typeof fetch;
}

/** Server-Sent Events streaming options (message/stream, tasks/resubscribe). */
export interface StreamingOptions {
  /**
   * Whether streaming methods are served. Defaults to the card's
   * capabilities.streaming flag, which is what clients read.
   */
  enabled?: boolean;
  /**
   * Interval between SSE keep-alive comments, in milliseconds, so idle
   * streams survive proxies that close quiet connections. Defaults to
   * 15000. Set to 0 to disable.
   */
  keepAliveMs?: number;
}

/** Options for `A2AServer.addTaskArtifact`. */
export interface AddTaskArtifactOptions {
  /**
   * Append the parts to the task's existing artifact with the same
   * artifactId instead of adding a new artifact. Streamed as `append: true`.
   */
  append?: boolean;
  /** Mark this as the final chunk of the artifact. Streamed as `lastChunk: true`. */
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** One open SSE connection subscribed to a task. */
interface StreamSubscriber {
  res: ServerResponse;
  requestId: JsonRpcId;
  /** Caller used a 1.0 method name: wrap events in StreamResponse. */
  v1: boolean;
  keepAlive?: NodeJS.Timeout;
  closed: boolean;
}

/** Configuration for the A2A server. */
export interface A2AServerConfig {
  /** Port to listen on. Defaults to 3141. Pass 0 to pick a free port. */
  port?: number;
  /**
   * The agent card to serve at GET /.well-known/agent-card.json (A2A v1.0)
   * and, for pre-1.0 clients, at /.well-known/agent.json and /agent-card.
   */
  agentCard: AgentCard;
  /** Optional Atom and JSON Feed endpoints for the agent's posts. */
  feed?: A2AFeedConfig;
  /**
   * `max-age` for the card's Cache-Control header, in seconds (A2A spec
   * section 8.6). Defaults to 3600. Set to 0 to ask clients to revalidate
   * on every fetch (the ETag still lets them get a 304).
   */
  cardMaxAgeSeconds?: number;
  /** Webhook delivery settings for tasks/pushNotificationConfig. */
  pushNotifications?: PushNotificationOptions;
  /** Server-Sent Events settings for message/stream and tasks/resubscribe. */
  streaming?: StreamingOptions;
}

const DEFAULT_PORT = 3141;
const DEFAULT_STREAM_KEEP_ALIVE_MS = 15_000;
/** Media type of an SSE response body. */
export const SSE_CONTENT_TYPE = 'text/event-stream';
const DEFAULT_CARD_MAX_AGE_SECONDS = 3600;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PUSH_TIMEOUT_MS = 5_000;
const PAGE_TOKEN_PREFIX = 'seq:';
/** Legacy convenience alias for the agent card, kept for existing callers. */
const CARD_ALIAS_PATH = '/agent-card';

/** Path of the Atom feed route. */
export const ATOM_FEED_PATH = '/feed.xml';

/** Path of the JSON Feed route. */
export const JSON_FEED_PATH = '/feed.json';

const {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  TASK_NOT_FOUND,
  TASK_NOT_CANCELABLE,
  PUSH_NOTIFICATION_NOT_SUPPORTED,
  UNSUPPORTED_OPERATION,
} = A2A_ERROR_CODES;

const MESSAGE_STREAM = 'message/stream';
const TASKS_RESUBSCRIBE = 'tasks/resubscribe';
const STREAMING_METHODS: ReadonlySet<string> = new Set([MESSAGE_STREAM, TASKS_RESUBSCRIBE]);

/** Build a JSON-RPC error object that the dispatcher forwards verbatim. */
export function rpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return data === undefined ? { code, message } : { code, message, data };
}

/** HTTP server that receives and routes A2A JSON-RPC 2.0 messages. */
export class A2AServer {
  private server: ReturnType<typeof createServer>;
  private handlers = new Map<string, A2AMethodHandler>();
  private tasks = new Map<string, Task>();
  /** Monotonic creation sequence per task id, used for cursor pagination. */
  private taskSeq = new Map<string, number>();
  private nextSeq = 1;
  /** taskId -> configId -> config */
  private pushConfigs = new Map<string, Map<string, PushNotificationConfig>>();
  private pendingDeliveries = new Set<Promise<void>>();
  /** taskId -> open SSE subscribers */
  private streams = new Map<string, Set<StreamSubscriber>>();
  private readonly port: number;
  private readonly cardMaxAgeSeconds: number;
  private readonly pushOptions: PushNotificationOptions;
  private readonly streamOptions: StreamingOptions;

  constructor(private config: A2AServerConfig) {
    this.port = config.port ?? DEFAULT_PORT;
    this.cardMaxAgeSeconds = Math.max(0, Math.floor(config.cardMaxAgeSeconds ?? DEFAULT_CARD_MAX_AGE_SECONDS));
    this.pushOptions = config.pushNotifications ?? {};
    this.streamOptions = config.streaming ?? {};
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.registerTaskHandlers();
  }

  /** Register a handler for an A2A method (e.g., 'message/send'). Overrides defaults. */
  onMethod(method: string, handler: A2AMethodHandler): void {
    this.handlers.set(method, handler);
  }

  /** Register default handlers for YouAgent social features. */
  registerYouAgentHandlers(options: {
    onFollow?: (data: YouAgentFollowData) => Promise<void>;
    onUnfollow?: (data: YouAgentUnfollowData) => Promise<void>;
    onPostsRequest?: (data: YouAgentPostsRequestData) => Promise<Post[]>;
    onMessage?: (message: Message) => Promise<Message>;
  }): void {
    this.onMethod('message/send', async (params: unknown) => {
      const raw = this.requireParams<MessageSendParams>(params, ['message']);
      if (!raw.message || !Array.isArray(raw.message.parts)) {
        throw rpcError(INVALID_PARAMS, 'message/send requires params.message with a parts array');
      }
      // Accept pre-0.2 peers that still send `type`-discriminated parts.
      let message: Message;
      try {
        message = normalizeMessage(raw.message);
      } catch (err) {
        throw rpcError(INVALID_PARAMS, err instanceof Error ? err.message : 'invalid message');
      }
      this.assertTaskAcceptsMessages(message);

      // Find YouAgent DataParts and route to social handlers
      for (const part of message.parts) {
        if (part.kind === 'data') {
          const dataType = (part.data as Record<string, unknown>).type as string | undefined;

          if (dataType === 'youagent/follow' && options.onFollow) {
            const followData = part.data as unknown as YouAgentFollowData;
            await options.onFollow(followData);
            return this.createTask(message, 'completed');
          }

          if (dataType === 'youagent/unfollow' && options.onUnfollow) {
            const unfollowData = part.data as unknown as YouAgentUnfollowData;
            await options.onUnfollow(unfollowData);
            return this.createTask(message, 'completed');
          }

          if (dataType === 'youagent/posts-request' && options.onPostsRequest) {
            const requestData = part.data as unknown as YouAgentPostsRequestData;
            const posts = await options.onPostsRequest(requestData);
            const responseData: YouAgentPostsResponseData = {
              type: 'youagent/posts-response',
              posts,
            };
            const artifact: Artifact = {
              artifactId: uuidv4(),
              name: 'posts',
              parts: [
                {
                  kind: 'data',
                  data: responseData as unknown as Record<string, unknown>,
                } satisfies DataPart,
              ],
            };
            return this.createTask(message, 'completed', [artifact]);
          }
        }
      }

      // Fall back to general message handler
      if (options.onMessage) {
        const responseMessage = await options.onMessage(message);
        return this.createTask(message, 'completed', undefined, responseMessage);
      }

      return this.createTask(message, 'completed');
    });
  }

  /**
   * Register the task lifecycle methods: tasks/get, tasks/list, tasks/cancel
   * and tasks/pushNotificationConfig/{set,get,list,delete}. Called by the
   * constructor; call again after onMethod overrides to restore defaults.
   */
  registerTaskHandlers(): void {
    this.onMethod('tasks/get', async (params: unknown) => {
      const { id, historyLength } = this.requireParams<TaskQueryParams>(params, ['id']);
      const task = this.requireTask(id);
      return applyHistoryLength(task, this.parseHistoryLength(historyLength));
    });

    this.onMethod('tasks/list', async (params: unknown) => this.listTasks((params ?? {}) as ListTasksParams));

    this.onMethod('tasks/cancel', async (params: unknown) => {
      const { id } = this.requireParams<TaskIdParams>(params, ['id']);
      const task = this.requireTask(id);
      if (isTerminalTaskState(task.status.state)) {
        throw rpcError(TASK_NOT_CANCELABLE, `Task ${id} is already ${task.status.state}`);
      }
      return this.setTaskStatus(id, 'canceled');
    });

    this.onMethod('tasks/pushNotificationConfig/set', async (params: unknown, request) => {
      this.assertPushSupported();
      const { taskId, config } = this.parseSetPushParams(params);
      this.requireTask(taskId);
      this.validateWebhookUrl(config.url);
      const stored: PushNotificationConfig = { ...config, id: config.id ?? uuidv4() };
      let byId = this.pushConfigs.get(taskId);
      if (!byId) {
        byId = new Map();
        this.pushConfigs.set(taskId, byId);
      }
      byId.set(stored.id as string, stored);
      return this.shapePushConfig({ taskId, pushNotificationConfig: stored }, request.method);
    });

    this.onMethod('tasks/pushNotificationConfig/get', async (params: unknown, request) => {
      this.assertPushSupported();
      const { taskId, configId } = this.parsePushRefParams(params, false);
      this.requireTask(taskId);
      const byId = this.pushConfigs.get(taskId);
      const config = configId ? byId?.get(configId) : byId?.values().next().value;
      if (!config) {
        throw rpcError(TASK_NOT_FOUND, `Push notification config not found for task ${taskId}`);
      }
      return this.shapePushConfig({ taskId, pushNotificationConfig: config }, request.method);
    });

    this.onMethod('tasks/pushNotificationConfig/list', async (params: unknown, request) => {
      this.assertPushSupported();
      const { taskId } = this.parsePushRefParams(params, false);
      this.requireTask(taskId);
      const configs = [...(this.pushConfigs.get(taskId)?.values() ?? [])].map((c) =>
        this.shapePushConfig({ taskId, pushNotificationConfig: c }, request.method),
      );
      // 1.0 wraps the list; 0.3 returns the bare array.
      return isV1Method(request.method) ? { configs, nextPageToken: '' } : configs;
    });

    this.onMethod('tasks/pushNotificationConfig/delete', async (params: unknown, request) => {
      this.assertPushSupported();
      const { taskId, configId } = this.parsePushRefParams(params, true);
      this.requireTask(taskId);
      const byId = this.pushConfigs.get(taskId);
      if (!byId?.delete(configId as string)) {
        throw rpcError(TASK_NOT_FOUND, `Push notification config ${configId} not found for task ${taskId}`);
      }
      if (byId.size === 0) {
        this.pushConfigs.delete(taskId);
      }
      return isV1Method(request.method) ? {} : null;
    });
  }

  /** Start listening for incoming connections. */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * The port the server is bound to. Equals the configured port until
   * `start()` resolves; useful when the server was started on port 0.
   */
  get listeningPort(): number {
    const address = this.server.address();
    if (address && typeof address === 'object') return address.port;
    return this.port;
  }

  /**
   * Stop the server gracefully. Waits for in-flight webhook deliveries first
   * and ends every open task stream, since an SSE connection would otherwise
   * keep the listener alive indefinitely.
   */
  async stop(): Promise<void> {
    await this.flushPushNotifications();
    this.closeAllStreams();
    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Bound address once started (useful with port 0). Null before start(). */
  address(): AddressInfo | null {
    const addr = this.server.address();
    return addr && typeof addr === 'object' ? addr : null;
  }

  // ── Task store (public for embedders) ─────────────────────────────────

  /** Look up a task by id, or undefined. */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * List tasks newest first with optional contextId/status filters and
   * cursor pagination (A2A 1.0 ListTasks semantics).
   */
  listTasks(params: ListTasksParams = {}): ListTasksResult {
    const pageSize = this.parsePageSize(params.pageSize);
    const afterSeq = this.parsePageToken(params.pageToken);
    const historyLength = this.parseHistoryLength(params.historyLength);
    const status = params.status === undefined ? undefined : normalizeTaskState(params.status);

    const matching = [...this.tasks.values()]
      .filter((t) => params.contextId === undefined || t.contextId === params.contextId)
      .filter((t) => status === undefined || t.status.state === status)
      .sort((a, b) => (this.taskSeq.get(b.id) ?? 0) - (this.taskSeq.get(a.id) ?? 0));

    const remaining =
      afterSeq === undefined ? matching : matching.filter((t) => (this.taskSeq.get(t.id) ?? 0) < afterSeq);
    const page = remaining.slice(0, pageSize);
    const hasMore = remaining.length > page.length;
    const last = page[page.length - 1];
    const nextPageToken =
      hasMore && last ? encodePageToken(this.taskSeq.get(last.id) ?? 0) : '';

    return {
      tasks: page.map((t) => applyHistoryLength(t, historyLength)),
      nextPageToken,
      pageSize,
      totalSize: matching.length,
    };
  }

  /**
   * Move a task to a new state and notify its push subscribers. Embedders
   * drive long-running work with this; it does not enforce terminal-state
   * rules (tasks/cancel over the wire does).
   */
  setTaskStatus(taskId: string, state: TaskState, message?: Message): Task {
    const task = this.requireTask(taskId);
    const status: TaskStatus = { state, timestamp: new Date().toISOString() };
    if (message) {
      status.message = message;
      task.history = [...(task.history ?? []), message];
    }
    task.status = status;
    this.notifyPushSubscribers(task);
    this.emitStatusUpdate(task);
    return task;
  }

  /**
   * Attach an artifact to a task and stream it to subscribers as a
   * TaskArtifactUpdateEvent. With `append: true` the parts are added to the
   * task's existing artifact that shares the artifactId (chunked output);
   * otherwise the artifact is added as a new entry. Returns the stored
   * artifact, with an artifactId generated when the caller omitted one.
   */
  addTaskArtifact(taskId: string, artifact: Artifact, options: AddTaskArtifactOptions = {}): Artifact {
    const task = this.requireTask(taskId);
    const artifactId = artifact.artifactId && artifact.artifactId !== '' ? artifact.artifactId : uuidv4();
    const incoming: Artifact = { ...artifact, artifactId };
    const artifacts = task.artifacts ?? [];
    const existing = options.append ? artifacts.find((a) => a.artifactId === artifactId) : undefined;
    if (existing) {
      existing.parts = [...existing.parts, ...incoming.parts];
      if (incoming.name !== undefined) existing.name = incoming.name;
      if (incoming.description !== undefined) existing.description = incoming.description;
      if (incoming.metadata !== undefined) existing.metadata = { ...existing.metadata, ...incoming.metadata };
    } else {
      artifacts.push(incoming);
    }
    task.artifacts = artifacts;

    const event: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: task.id,
      contextId: task.contextId,
      artifact: incoming,
    };
    if (options.append) event.append = true;
    if (options.lastChunk) event.lastChunk = true;
    if (options.metadata) event.metadata = options.metadata;
    this.broadcast(task.id, event);
    return existing ?? incoming;
  }

  /** Resolve once every webhook delivery started so far has settled. */
  async flushPushNotifications(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.allSettled([...this.pendingDeliveries]);
    }
  }

  /** Whether the server accepts push notification configs. */
  get pushNotificationsEnabled(): boolean {
    return this.pushOptions.enabled ?? this.config.agentCard.capabilities?.pushNotifications === true;
  }

  /** Whether message/stream and tasks/resubscribe are served. */
  get streamingEnabled(): boolean {
    return this.streamOptions.enabled ?? this.config.agentCard.capabilities?.streaming === true;
  }

  /** Number of open SSE subscriptions, for one task or across all tasks. */
  openStreamCount(taskId?: string): number {
    if (taskId !== undefined) return this.streams.get(taskId)?.size ?? 0;
    let total = 0;
    for (const subscribers of this.streams.values()) total += subscribers.size;
    return total;
  }

  /**
   * Record a task for an incoming message. Custom `message/send` handlers
   * registered with `onMethod` call this so the task lands in the store that
   * tasks/get, tasks/list, tasks/resubscribe and push notifications read;
   * start long-running work in `submitted` or `working` and finish it with
   * `setTaskStatus`. When the message carries a `taskId` of an existing task
   * the task is updated in place and its history extended.
   */
  createTask(
    incomingMessage: Message,
    state: Task['status']['state'],
    artifacts?: Artifact[],
    responseMessage?: Message,
  ): Task {
    const taskId = incomingMessage.taskId ?? uuidv4();
    const contextId = incomingMessage.contextId ?? uuidv4();

    const status: TaskStatus = {
      state,
      message: responseMessage,
      timestamp: new Date().toISOString(),
    };

    const existing = this.tasks.get(taskId);
    const history = existing?.history ? [...existing.history, incomingMessage] : [incomingMessage];
    if (responseMessage) {
      history.push(responseMessage);
    }

    const task: Task = {
      kind: 'task',
      id: taskId,
      contextId,
      status,
      history,
      artifacts: artifacts ?? existing?.artifacts,
    };

    this.tasks.set(taskId, task);
    if (!this.taskSeq.has(taskId)) {
      this.taskSeq.set(taskId, this.nextSeq++);
    }
    this.notifyPushSubscribers(task);
    // A follow-up message to a task someone is already streaming is a status change for them.
    if (existing) this.emitStatusUpdate(task);
    return task;
  }

  // ── Streaming (SSE) ────────────────────────────────────────────────────

  /**
   * Serve message/stream (SendStreamingMessage): run the registered
   * message/send handler, then open an SSE stream that starts with the
   * resulting Task (or a direct Message) and follows the task until it
   * reaches a terminal state. Errors raised before the first byte are sent as
   * ordinary JSON-RPC error responses.
   */
  private async handleMessageStream(req: IncomingMessage, res: ServerResponse, request: JsonRpcRequest): Promise<void> {
    const handler = this.handlers.get('message/send');
    if (!handler) {
      this.sendJsonRpcError(res, request.id, METHOD_NOT_FOUND, 'No message/send handler is registered');
      return;
    }

    let result: unknown;
    try {
      result = await handler(request.params, { ...request, method: 'message/send' });
    } catch (err) {
      this.sendHandlerError(res, request.id, err);
      return;
    }

    const v1 = isV1Method(request.method);
    const subscriber = this.openStream(req, res, request.id, v1);

    if (isTaskResult(result)) {
      const task = result;
      this.writeEvent(subscriber, task);
      if (isTerminalTaskState(task.status.state)) {
        this.endStream(subscriber);
      } else {
        this.subscribe(task.id, subscriber);
      }
      return;
    }

    // Message-only stream: exactly one Message, then close (spec section 3.1.2).
    this.writeEvent(subscriber, result as Message);
    this.endStream(subscriber);
  }

  /**
   * Serve tasks/resubscribe (SubscribeToTask): replay the current Task
   * snapshot and follow the task until it reaches a terminal state. Terminal
   * tasks are refused with UnsupportedOperationError (spec section 9.4.6).
   */
  private handleResubscribe(req: IncomingMessage, res: ServerResponse, request: JsonRpcRequest): void {
    let task: Task;
    try {
      const { id } = this.requireParams<TaskIdParams>(request.params, ['id']);
      task = this.requireTask(id);
    } catch (err) {
      this.sendHandlerError(res, request.id, err);
      return;
    }
    if (isTerminalTaskState(task.status.state)) {
      this.sendJsonRpcError(
        res,
        request.id,
        UNSUPPORTED_OPERATION,
        `Task ${task.id} is ${task.status.state}; there are no further updates to subscribe to`,
      );
      return;
    }

    const subscriber = this.openStream(req, res, request.id, isV1Method(request.method));
    this.writeEvent(subscriber, task);
    this.subscribe(task.id, subscriber);
  }

  /** Send SSE headers and set up keep-alives plus disconnect cleanup. */
  private openStream(req: IncomingMessage, res: ServerResponse, requestId: JsonRpcId, v1: boolean): StreamSubscriber {
    const subscriber: StreamSubscriber = { res, requestId, v1, closed: false };
    res.writeHead(200, {
      'Content-Type': SSE_CONTENT_TYPE,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const keepAliveMs = this.streamOptions.keepAliveMs ?? DEFAULT_STREAM_KEEP_ALIVE_MS;
    if (keepAliveMs > 0) {
      subscriber.keepAlive = setInterval(() => {
        if (!subscriber.closed) res.write(': keep-alive\n\n');
      }, keepAliveMs);
      subscriber.keepAlive.unref();
    }

    const onClose = () => this.dropSubscriber(subscriber);
    res.once('close', onClose);
    req.once('close', onClose);
    return subscriber;
  }

  private subscribe(taskId: string, subscriber: StreamSubscriber): void {
    if (subscriber.closed) return;
    let set = this.streams.get(taskId);
    if (!set) {
      set = new Set();
      this.streams.set(taskId, set);
    }
    set.add(subscriber);
  }

  /** Write one stream item as a JSON-RPC response inside an SSE `data:` frame. */
  private writeEvent(subscriber: StreamSubscriber, event: StreamEvent): void {
    if (subscriber.closed) return;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: subscriber.requestId,
      result: subscriber.v1 ? toStreamResponse(event) : event,
    };
    subscriber.res.write(`data: ${JSON.stringify(response)}\n\n`);
  }

  private endStream(subscriber: StreamSubscriber): void {
    if (subscriber.closed) return;
    this.dropSubscriber(subscriber);
    subscriber.res.end();
  }

  /** Forget a subscriber everywhere and stop its keep-alive timer. */
  private dropSubscriber(subscriber: StreamSubscriber): void {
    subscriber.closed = true;
    if (subscriber.keepAlive) clearInterval(subscriber.keepAlive);
    for (const [taskId, set] of this.streams) {
      if (set.delete(subscriber) && set.size === 0) this.streams.delete(taskId);
    }
  }

  /** Stream a task's current status to its subscribers; close them when the task is terminal. */
  private emitStatusUpdate(task: Task): void {
    const subscribers = this.streams.get(task.id);
    if (!subscribers || subscribers.size === 0) return;
    const final = isTerminalTaskState(task.status.state);
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
      final,
    };
    this.broadcast(task.id, event);
    if (final) {
      for (const subscriber of [...subscribers]) this.endStream(subscriber);
    }
  }

  private broadcast(taskId: string, event: StreamEvent): void {
    const subscribers = this.streams.get(taskId);
    if (!subscribers) return;
    for (const subscriber of [...subscribers]) this.writeEvent(subscriber, event);
  }

  private closeAllStreams(): void {
    for (const set of [...this.streams.values()]) {
      for (const subscriber of [...set]) this.endStream(subscriber);
    }
    this.streams.clear();
  }

  /** A follow-up message must target an existing, non-terminal task. */
  private assertTaskAcceptsMessages(message: Message): void {
    if (!message.taskId) return;
    const task = this.tasks.get(message.taskId);
    if (!task) {
      throw rpcError(TASK_NOT_FOUND, `Task not found: ${message.taskId}`);
    }
    if (isTerminalTaskState(task.status.state)) {
      throw rpcError(
        UNSUPPORTED_OPERATION,
        `Task ${message.taskId} is ${task.status.state} and no longer accepts messages`,
      );
    }
  }

  private requireTask(taskId: unknown): Task {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw rpcError(INVALID_PARAMS, 'Task id must be a non-empty string');
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      throw rpcError(TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }
    return task;
  }

  private requireParams<T extends object>(params: unknown, keys: Array<keyof T>): T {
    if (!params || typeof params !== 'object') {
      throw rpcError(INVALID_PARAMS, 'Missing params object');
    }
    for (const key of keys) {
      if ((params as Record<string, unknown>)[key as string] === undefined) {
        throw rpcError(INVALID_PARAMS, `Missing required param: ${String(key)}`);
      }
    }
    return params as T;
  }

  private parsePageSize(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw rpcError(INVALID_PARAMS, 'pageSize must be an integer of at least 1');
    }
    return Math.min(value, MAX_PAGE_SIZE);
  }

  private parsePageToken(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
      throw rpcError(INVALID_PARAMS, 'pageToken must be a string');
    }
    const seq = decodePageToken(value);
    if (seq === undefined) {
      throw rpcError(INVALID_PARAMS, 'pageToken is not a token issued by this server');
    }
    return seq;
  }

  private parseHistoryLength(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw rpcError(INVALID_PARAMS, 'historyLength must be a non-negative integer');
    }
    return value;
  }

  private assertPushSupported(): void {
    if (!this.pushNotificationsEnabled) {
      throw rpcError(
        PUSH_NOTIFICATION_NOT_SUPPORTED,
        'Push notifications are not supported by this agent (capabilities.pushNotifications is false)',
      );
    }
  }

  /**
   * Accept both the 0.3 nested shape { taskId, pushNotificationConfig: {...} }
   * and the 1.0 flattened shape { taskId, id?, url, token?, authentication? }.
   */
  private parseSetPushParams(params: unknown): { taskId: string; config: PushNotificationConfig } {
    const p = this.requireParams<Record<string, unknown>>(params, ['taskId']);
    const raw = (p.pushNotificationConfig ?? p) as Record<string, unknown>;
    if (typeof raw.url !== 'string') {
      throw rpcError(INVALID_PARAMS, 'pushNotificationConfig.url must be a string');
    }
    if (raw.id !== undefined && typeof raw.id !== 'string') {
      throw rpcError(INVALID_PARAMS, 'pushNotificationConfig.id must be a string');
    }
    if (raw.token !== undefined && typeof raw.token !== 'string') {
      throw rpcError(INVALID_PARAMS, 'pushNotificationConfig.token must be a string');
    }
    const auth = raw.authentication as Record<string, unknown> | undefined;
    if (auth !== undefined) {
      if (!auth || typeof auth !== 'object' || !Array.isArray(auth.schemes)) {
        throw rpcError(INVALID_PARAMS, 'pushNotificationConfig.authentication.schemes must be an array');
      }
      if (auth.credentials !== undefined && typeof auth.credentials !== 'string') {
        throw rpcError(INVALID_PARAMS, 'pushNotificationConfig.authentication.credentials must be a string');
      }
    }
    const config: PushNotificationConfig = { url: raw.url };
    if (raw.id !== undefined) config.id = raw.id as string;
    if (raw.token !== undefined) config.token = raw.token as string;
    if (auth) {
      config.authentication = { schemes: auth.schemes as string[] };
      if (auth.credentials !== undefined) config.authentication.credentials = auth.credentials as string;
    }
    return { taskId: p.taskId as string, config };
  }

  /**
   * Resolve task id and config id from either wire shape:
   * 0.3: { id: taskId, pushNotificationConfigId? }
   * 1.0: { taskId, id?: configId }
   */
  private parsePushRefParams(
    params: unknown,
    configRequired: boolean,
  ): { taskId: string; configId?: string } {
    const p = this.requireParams<Record<string, unknown>>(params, []);
    const taskId = (p.taskId ?? p.id) as unknown;
    const configId = (p.pushNotificationConfigId ?? (p.taskId !== undefined ? p.id : undefined)) as unknown;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw rpcError(INVALID_PARAMS, 'Task id must be a non-empty string');
    }
    if (configId !== undefined && typeof configId !== 'string') {
      throw rpcError(INVALID_PARAMS, 'Push notification config id must be a string');
    }
    if (configRequired && !configId) {
      throw rpcError(INVALID_PARAMS, 'Push notification config id is required');
    }
    return { taskId, configId: configId as string | undefined };
  }

  /** 0.3 methods return the nested shape; 1.0 aliases return the flattened one. */
  private shapePushConfig(entry: TaskPushNotificationConfig, method: string): unknown {
    if (!isV1Method(method)) return entry;
    return { taskId: entry.taskId, ...entry.pushNotificationConfig };
  }

  private validateWebhookUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw rpcError(INVALID_PARAMS, `Webhook URL is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw rpcError(INVALID_PARAMS, 'Webhook URL must use http or https');
    }
    if (!this.pushOptions.allowPrivateHosts && isPrivateHost(parsed.hostname)) {
      throw rpcError(
        INVALID_PARAMS,
        'Webhook URL must not target loopback or private-network hosts (set pushNotifications.allowPrivateHosts to override)',
      );
    }
  }

  /** POST the task to every webhook registered for it. Best-effort, never throws. */
  private notifyPushSubscribers(task: Task): void {
    const byId = this.pushConfigs.get(task.id);
    if (!byId || byId.size === 0 || !this.pushNotificationsEnabled) return;
    const fetchImpl = this.pushOptions.fetch ?? globalThis.fetch;
    const timeoutMs = this.pushOptions.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
    const body = JSON.stringify(task);

    for (const config of byId.values()) {
      const entry: TaskPushNotificationConfig = { taskId: task.id, pushNotificationConfig: config };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.token) headers['X-A2A-Notification-Token'] = config.token;
      const auth = config.authentication;
      if (auth?.credentials && auth.schemes.some((s) => s.toLowerCase() === 'bearer')) {
        headers['Authorization'] = `Bearer ${auth.credentials}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const delivery = fetchImpl(config.url, { method: 'POST', headers, body, signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`Webhook responded HTTP ${res.status}`);
        })
        .catch((err: unknown) => {
          this.pushOptions.onDeliveryError?.(err, entry);
        })
        .finally(() => {
          clearTimeout(timer);
          this.pendingDeliveries.delete(delivery);
        });
      this.pendingDeliveries.add(delivery);
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase() ?? '';
    const pathname = this.pathnameOf(req.url ?? '/');

    // GET /health
    if (method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Agent card discovery: A2A v1.0 well-known path, plus the pre-1.0 path
    // and the /agent-card alias so older clients keep working.
    if (
      (method === 'GET' || method === 'HEAD') &&
      (pathname === A2A_WELL_KNOWN_PATH ||
        pathname === A2A_LEGACY_WELL_KNOWN_PATH ||
        pathname === CARD_ALIAS_PATH)
    ) {
      this.sendAgentCard(req, res, pathname === A2A_WELL_KNOWN_PATH);
      return;
    }

    // GET /feed.xml and /feed.json (syndication, only when a feed is configured)
    if (
      method === 'GET' &&
      this.config.feed &&
      (pathname === ATOM_FEED_PATH || pathname === JSON_FEED_PATH)
    ) {
      await this.handleFeed(res, new URL(req.url ?? '/', 'http://localhost'));
      return;
    }

    // POST / : JSON-RPC 2.0 dispatcher
    if (method === 'POST' && pathname === '/') {
      await this.handleJsonRpc(req, res);
      return;
    }

    this.sendJson(res, 404, { error: 'not found' });
  }

  private async handleFeed(res: ServerResponse, parsed: URL): Promise<void> {
    const feed = this.config.feed;
    if (!feed) {
      this.sendJson(res, 404, { error: 'not found' });
      return;
    }

    const limit = parseFeedLimit(
      parsed.searchParams.get('limit'),
      feed.defaultLimit ?? DEFAULT_FEED_LIMIT,
    );

    let posts: Post[];
    try {
      posts = await feed.getPosts(limit);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to load posts';
      this.sendJson(res, 500, { error: message });
      return;
    }

    const card = this.config.agentCard;
    const ident = getAgentIdentifier(card);
    const cardUrl = getAgentUrl(card);
    const base = (feed.publicUrl ?? cardUrl).replace(/\/+$/, '');
    const isAtom = parsed.pathname === ATOM_FEED_PATH;

    const options: FeedOptions = {
      title: feed.title,
      description: feed.description ?? card.description,
      siteUrl: cardUrl,
      feedUrl: `${base}${isAtom ? ATOM_FEED_PATH : JSON_FEED_PATH}`,
      agentHandle: ident.handle,
      agentId: ident.id,
    };

    const body = isAtom
      ? renderAtomFeed(posts.slice(0, limit), options)
      : renderJsonFeed(posts.slice(0, limit), options);

    res.writeHead(200, {
      'Content-Type': isAtom ? ATOM_CONTENT_TYPE : JSON_FEED_CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'public, max-age=300',
    });
    res.end(body);
  }

  /** Path component of a request URL, ignoring any query string. */
  private pathnameOf(rawUrl: string): string {
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      return rawUrl;
    }
  }

  /**
   * Serve the agent card with the caching headers the A2A spec asks for
   * (section 8.6): an ETag derived from the card content, a Cache-Control
   * max-age, and 304 Not Modified for matching If-None-Match requests.
   *
   * The v1.0 well-known path answers with `application/a2a+json`; the legacy
   * paths keep `application/json` for clients that predate the media type.
   */
  private sendAgentCard(req: IncomingMessage, res: ServerResponse, v1Path: boolean): void {
    const body = JSON.stringify(this.config.agentCard);
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    const headers: Record<string, string> = {
      'Content-Type': v1Path ? A2A_CARD_MEDIA_TYPE : 'application/json',
      'Cache-Control': `public, max-age=${this.cardMaxAgeSeconds}`,
      ETag: etag,
    };

    if (this.etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    headers['Content-Length'] = String(Buffer.byteLength(body));
    res.writeHead(200, headers);
    if (req.method?.toUpperCase() === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  }

  /** RFC 9110 If-None-Match evaluation: weak comparison, `*` matches any. */
  private etagMatches(header: string | string[] | undefined, etag: string): boolean {
    if (!header) return false;
    const raw = Array.isArray(header) ? header.join(',') : header;
    const strip = (tag: string) => tag.trim().replace(/^W\//, '');
    const target = strip(etag);
    return raw.split(',').some((candidate) => {
      const c = candidate.trim();
      return c === '*' || strip(c) === target;
    });
  }

  private async handleJsonRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await this.readBody(req);
    } catch {
      this.sendJsonRpcError(res, null, PARSE_ERROR, 'Failed to read request body');
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.sendJsonRpcError(res, null, PARSE_ERROR, 'Invalid JSON');
      return;
    }

    // Validate JSON-RPC structure (ids may be strings or numbers, including 0)
    const hasId =
      request !== null &&
      typeof request === 'object' &&
      (typeof request.id === 'string' || typeof request.id === 'number');
    if (!hasId || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      this.sendJsonRpcError(
        res,
        hasId ? request.id : null,
        INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request: missing jsonrpc, id, or method',
      );
      return;
    }

    // Route to handler, accepting 1.0 PascalCase aliases
    const canonical = A2A_V1_METHOD_ALIASES[request.method] ?? request.method;

    // Streaming methods answer with SSE and are gated on the card's capability
    // (spec: Capability Validation). They bypass the unary handler table.
    if (STREAMING_METHODS.has(canonical)) {
      if (!this.streamingEnabled) {
        this.sendJsonRpcError(
          res,
          request.id,
          UNSUPPORTED_OPERATION,
          `${request.method} is not supported: this agent does not stream (capabilities.streaming is false)`,
        );
        return;
      }
      if (canonical === MESSAGE_STREAM) {
        await this.handleMessageStream(req, res, request);
      } else {
        this.handleResubscribe(req, res, request);
      }
      return;
    }

    const handler = this.handlers.get(canonical);
    if (!handler) {
      this.sendJsonRpcError(res, request.id, METHOD_NOT_FOUND, `Method not found: ${request.method}`);
      return;
    }

    try {
      const result = await handler(request.params, request);
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
      this.sendJson(res, 200, response);
    } catch (err) {
      this.sendHandlerError(res, request.id, err);
    }
  }

  /** Map a thrown handler error to a JSON-RPC error response. */
  private sendHandlerError(res: ServerResponse, id: JsonRpcId, err: unknown): void {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      // Already a JsonRpcError-shaped object
      const rpcErr = err as JsonRpcError;
      this.sendJsonRpcError(res, id, rpcErr.code, rpcErr.message, rpcErr.data);
    } else {
      const message = err instanceof Error ? err.message : 'Internal error';
      this.sendJsonRpcError(res, id, INTERNAL_ERROR, message);
    }
  }

  private sendJsonRpcError(
    res: ServerResponse,
    id: JsonRpcId | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: rpcError(code, message, data),
    };
    this.sendJson(res, 200, response);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** True for A2A 1.0 PascalCase method names. */
function isV1Method(method: string): boolean {
  return method in A2A_V1_METHOD_ALIASES;
}

/** True when a message/send handler returned a Task rather than a direct Message. */
function isTaskResult(result: unknown): result is Task {
  return (
    result !== null &&
    typeof result === 'object' &&
    typeof (result as Task).id === 'string' &&
    (result as Task).status !== undefined &&
    typeof (result as Task).status === 'object'
  );
}

/**
 * Wrap a 0.3-shaped stream item in the A2A 1.0 `StreamResponse` oneof. The
 * 0.3-only fields (`kind` on events, `final` on status updates) are dropped;
 * 1.0 clients read the stream closing as the final signal.
 */
export function toStreamResponse(event: StreamEvent): StreamResponse {
  if ((event as TaskStatusUpdateEvent).kind === 'status-update') {
    const { kind: _kind, final: _final, ...statusUpdate } = event as TaskStatusUpdateEvent;
    return { statusUpdate };
  }
  if ((event as TaskArtifactUpdateEvent).kind === 'artifact-update') {
    const { kind: _kind, ...artifactUpdate } = event as TaskArtifactUpdateEvent;
    return { artifactUpdate };
  }
  if ((event as Task).status !== undefined && typeof (event as Task).id === 'string') {
    return { task: event as Task };
  }
  return { message: event as Message };
}

/**
 * Accept "working", "TASK_STATE_WORKING" or "TASK_STATE_INPUT_REQUIRED" and
 * return the 0.3 lowercase state youagent stores. Unknown values raise
 * InvalidParams.
 */
export function normalizeTaskState(value: string): TaskState {
  const lowered = value.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-');
  const known: TaskState[] = [
    'submitted',
    'working',
    'input-required',
    'auth-required',
    'completed',
    'canceled',
    'failed',
    'rejected',
  ];
  if ((known as string[]).includes(lowered)) {
    return lowered as TaskState;
  }
  throw rpcError(INVALID_PARAMS, `Unknown task state: ${value}`);
}

/** Apply A2A historyLength semantics: unset = all, 0 = omit, n = last n. */
export function applyHistoryLength(task: Task, historyLength: number | undefined): Task {
  if (historyLength === undefined) return task;
  if (historyLength === 0) {
    const { history: _history, ...rest } = task;
    return rest;
  }
  return { ...task, history: (task.history ?? []).slice(-historyLength) };
}

function encodePageToken(seq: number): string {
  return Buffer.from(`${PAGE_TOKEN_PREFIX}${seq}`, 'utf-8').toString('base64url');
}

function decodePageToken(token: string): number | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return undefined;
  }
  if (!decoded.startsWith(PAGE_TOKEN_PREFIX)) return undefined;
  const seq = Number(decoded.slice(PAGE_TOKEN_PREFIX.length));
  return Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

/** True for a dotted-quad IPv4 string in a loopback / private / link-local range. */
function isPrivateIpv4(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Pull the embedded IPv4 out of an IPv4-mapped or IPv4-compatible IPv6
 * address. `new URL()` canonicalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1`,
 * so the dotted form alone is not enough to catch a loopback target.
 */
function mappedIpv4(host: string): string | undefined {
  const m = host.match(/^::(?:ffff:)?(?:0{1,4}:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return dotted ? dotted[1] : undefined;
}

/** Loopback, link-local and RFC 1918 / RFC 4193 hosts. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:7f00:1) reaches the same host as 127.0.0.1.
  const mapped = mappedIpv4(host);
  if (mapped) return isPrivateIpv4(mapped);
  return isPrivateIpv4(host);
}
