/**
 * Model Context Protocol (MCP) wire types.
 *
 * MCP is JSON-RPC 2.0. Over the stdio transport, each message is one line
 * of JSON (no embedded newlines) on stdin/stdout. Only the subset youagent
 * serves is typed here: initialize, ping, tools, and resources.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18
 */

export type McpJsonRpcId = string | number | null;

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: McpJsonRpcId;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: McpJsonRpcId;
  result?: unknown;
  error?: McpJsonRpcError;
}

/** Standard JSON-RPC 2.0 error codes used by MCP. */
export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Protocol revisions this server speaks, newest first. On `initialize` the
 * server echoes the client's version when it is in this list and otherwise
 * answers with the newest one it supports, as the spec's version negotiation
 * requires.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type McpProtocolVersion = (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** The newest revision this server speaks. */
export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];

export interface McpImplementation {
  name: string;
  version: string;
  title?: string;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
}

export interface McpInitializeParams {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: McpImplementation;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpImplementation;
  instructions?: string;
}

/** Behavioral hints a client may show the user before running a tool. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  /** JSON Schema (draft 2020-12 compatible object schema) for `arguments`. */
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: McpTextContent[];
  /** Machine readable mirror of `content` for clients that support it. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpReadResourceParams {
  uri: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface McpReadResourceResult {
  contents: McpResourceContents[];
}
