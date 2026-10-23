/**
 * MCP (Model Context Protocol) server for youagent.
 */

export {
  YouAgentMcpServer,
  McpRpcError,
  MCP_TOOLS,
  MCP_CARD_RESOURCE_URI,
  MCP_FEED_RESOURCE_URI,
  MCP_DEFAULT_POST_LIMIT,
  MCP_MAX_POST_LIMIT,
  MCP_DEFAULT_ENTITY_LIMIT,
  MCP_MAX_ENTITY_LIMIT,
  MCP_MAX_SEARCH_LIMIT,
  MCP_FEED_RESOURCE_LIMIT,
  questionTerms,
} from './mcp-server.js';
export type { McpServerConfig, AnswerProvider } from './mcp-server.js';
export {
  MCP_ERROR_CODES,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_LATEST_PROTOCOL_VERSION,
} from './types.js';
export type {
  McpJsonRpcId,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpJsonRpcError,
  McpProtocolVersion,
  McpImplementation,
  McpServerCapabilities,
  McpInitializeParams,
  McpInitializeResult,
  McpTool,
  McpToolAnnotations,
  McpTextContent,
  McpCallToolParams,
  McpCallToolResult,
  McpResource,
  McpReadResourceParams,
  McpReadResourceResult,
  McpResourceContents,
} from './types.js';
