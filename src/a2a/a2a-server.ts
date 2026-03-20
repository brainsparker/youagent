/**
 * A2A server for handling incoming agent-to-agent messages.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentCard } from '../types/agent-card.js';
import type { A2AMessage, A2AMessageType, A2AResponse } from './types.js';

/** Handler function for a specific A2A message type. */
export type A2AHandler = (message: A2AMessage) => Promise<A2AResponse>;

/** Configuration for the A2A server. */
export interface A2AServerConfig {
  /** Port to listen on. Defaults to 3141. */
  port?: number;
  /** The agent card to serve at GET /agent-card. */
  agentCard: AgentCard;
}

const DEFAULT_PORT = 3141;

/** HTTP server that receives and routes A2A protocol messages. */
export class A2AServer {
  private server: ReturnType<typeof createServer>;
  private handlers = new Map<A2AMessageType, A2AHandler>();
  private readonly port: number;

  constructor(private config: A2AServerConfig) {
    this.port = config.port ?? DEFAULT_PORT;
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  /** Register a handler for a specific A2A message type. */
  onMessage(type: A2AMessageType, handler: A2AHandler): void {
    this.handlers.set(type, handler);
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

  // ── private ──────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase() ?? '';
    const url = req.url ?? '/';

    // GET /health
    if (method === 'GET' && url === '/health') {
      this.sendJson(res, 200, { status: 'ok' });
      return;
    }

    // GET /agent-card
    if (method === 'GET' && url === '/agent-card') {
      this.sendJson(res, 200, this.config.agentCard);
      return;
    }

    // POST / — A2A message
    if (method === 'POST' && url === '/') {
      await this.handleA2AMessage(req, res);
      return;
    }

    this.sendJson(res, 404, { error: 'not found' });
  }

  private async handleA2AMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await this.readBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'failed to read request body' });
      return;
    }

    let message: A2AMessage;
    try {
      message = JSON.parse(body) as A2AMessage;
    } catch {
      this.sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }

    if (!message.type || !message.messageId) {
      this.sendJson(res, 400, {
        success: false,
        messageId: message.messageId ?? '',
        error: 'missing required fields: type, messageId',
      } satisfies A2AResponse);
      return;
    }

    // Handle ping natively
    if (message.type === 'ping') {
      this.sendJson(res, 200, {
        success: true,
        messageId: message.messageId,
        data: { type: 'pong' },
      } satisfies A2AResponse);
      return;
    }

    const handler = this.handlers.get(message.type);
    if (!handler) {
      this.sendJson(res, 400, {
        success: false,
        messageId: message.messageId,
        error: `no handler for message type: ${message.type}`,
      } satisfies A2AResponse);
      return;
    }

    try {
      const response = await handler(message);
      this.sendJson(res, 200, response);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'internal error';
      this.sendJson(res, 500, {
        success: false,
        messageId: message.messageId,
        error: errorMessage,
      } satisfies A2AResponse);
    }
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
