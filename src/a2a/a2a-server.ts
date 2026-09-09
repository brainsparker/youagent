/**
 * A2A server — JSON-RPC 2.0 based agent-to-agent message handling.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { AgentCard } from '../types/agent-card.js';
import {
  A2A_CARD_MEDIA_TYPE,
  A2A_LEGACY_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
} from '../types/agent-card.js';
import type { Post } from '../types/post.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  Message,
  Task,
  TaskStatus,
  Artifact,
  Part,
  DataPart,
  MessageSendParams,
  TaskQueryParams,
  TaskIdParams,
  YouAgentFollowData,
  YouAgentUnfollowData,
  YouAgentPostsRequestData,
  YouAgentPostsResponseData,
} from './types.js';

/** Handler function for an A2A JSON-RPC method. */
export type A2AMethodHandler = (params: unknown, request: JsonRpcRequest) => Promise<unknown>;

/** Configuration for the A2A server. */
export interface A2AServerConfig {
  /** Port to listen on. Defaults to 3141. Use 0 for an ephemeral port. */
  port?: number;
  /**
   * The agent card to serve at GET /.well-known/agent-card.json (A2A v1.0)
   * and, for pre-1.0 clients, at /.well-known/agent.json and /agent-card.
   */
  agentCard: AgentCard;
  /**
   * `max-age` for the card's Cache-Control header, in seconds (A2A spec
   * section 8.6). Defaults to 3600. Set to 0 to ask clients to revalidate
   * on every fetch (the ETag still lets them get a 304).
   */
  cardMaxAgeSeconds?: number;
}

const DEFAULT_PORT = 3141;
const DEFAULT_CARD_MAX_AGE_SECONDS = 3600;
/** Legacy convenience alias for the agent card, kept for existing callers. */
const CARD_ALIAS_PATH = '/agent-card';

// JSON-RPC 2.0 standard error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** HTTP server that receives and routes A2A JSON-RPC 2.0 messages. */
export class A2AServer {
  private server: ReturnType<typeof createServer>;
  private handlers = new Map<string, A2AMethodHandler>();
  private tasks = new Map<string, Task>();
  private readonly port: number;
  private readonly cardMaxAgeSeconds: number;

  constructor(private config: A2AServerConfig) {
    this.port = config.port ?? DEFAULT_PORT;
    this.cardMaxAgeSeconds = Math.max(0, Math.floor(config.cardMaxAgeSeconds ?? DEFAULT_CARD_MAX_AGE_SECONDS));
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  /**
   * The port the server is bound to, or null before `start()` resolves.
   * Useful when the server was started with `port: 0`.
   */
  address(): { port: number } | null {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return { port: addr.port };
    }
    return null;
  }

  /** Register a handler for an A2A method (e.g., 'message/send'). */
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
      const { message } = params as MessageSendParams;

      // Find YouAgent DataParts and route to social handlers
      for (const part of message.parts) {
        if (part.type === 'data') {
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
              name: 'posts',
              parts: [
                {
                  type: 'data',
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

    this.onMethod('tasks/get', async (params: unknown) => {
      const { id } = params as TaskQueryParams;
      const task = this.tasks.get(id);
      if (!task) {
        const error: JsonRpcError = { code: -32001, message: `Task not found: ${id}` };
        throw error;
      }
      return task;
    });

    this.onMethod('tasks/cancel', async (params: unknown) => {
      const { id } = params as TaskIdParams;
      const task = this.tasks.get(id);
      if (!task) {
        const error: JsonRpcError = { code: -32001, message: `Task not found: ${id}` };
        throw error;
      }
      task.status = {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      };
      return task;
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

  /** Stop the server gracefully. */
  async stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ── Private ────────────────────────────────────────────────────────────

  private createTask(
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
      id: taskId,
      contextId,
      status,
      history,
      artifacts: artifacts ?? existing?.artifacts,
    };

    this.tasks.set(taskId, task);
    return task;
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

    // POST / : JSON-RPC 2.0 dispatcher
    if (method === 'POST' && pathname === '/') {
      await this.handleJsonRpc(req, res);
      return;
    }

    this.sendJson(res, 404, { error: 'not found' });
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

    // Validate JSON-RPC structure
    if (request.jsonrpc !== '2.0' || !request.id || !request.method) {
      this.sendJsonRpcError(
        res,
        request.id ?? null,
        INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request: missing jsonrpc, id, or method',
      );
      return;
    }

    // Route to handler
    const handler = this.handlers.get(request.method);
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
      if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
        // Already a JsonRpcError-shaped object
        const rpcError = err as JsonRpcError;
        this.sendJsonRpcError(res, request.id, rpcError.code, rpcError.message, rpcError.data);
      } else {
        const message = err instanceof Error ? err.message : 'Internal error';
        this.sendJsonRpcError(res, request.id, INTERNAL_ERROR, message);
      }
    }
  }

  private sendJsonRpcError(
    res: ServerResponse,
    id: string | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? '',
      error: { code, message, data },
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
