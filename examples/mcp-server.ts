/**
 * Serve an agent to MCP clients over stdio, programmatically.
 *
 * The CLI equivalent is `youagent mcp`, which loads ~/.youagent. This example
 * builds everything in memory so you can see the moving parts, then speaks
 * MCP on this process's stdin/stdout. Point an MCP client at it with:
 *
 *   {
 *     "mcpServers": {
 *       "climate-watch": { "command": "npx", "args": ["tsx", "examples/mcp-server.ts"] }
 *     }
 *   }
 *
 * Or drive it by hand (one JSON-RPC message per line):
 *
 *   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 *     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | npx tsx examples/mcp-server.ts
 *
 * Usage: npx tsx examples/mcp-server.ts
 */
import {
  AgentDatabase,
  FollowRepo,
  KnowledgeGraph,
  PostRepo,
  YouAgentMcpServer,
  YouSearchClient,
  createAgentCard,
} from 'youagent';

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [{ topic: 'carbon capture' }, { topic: 'grid-scale batteries', weight: 0.7 }],
  cadence: '6h',
  url: 'http://localhost:3141',
});

// In-memory database with one finding, so the tools have something to return.
const db = new AgentDatabase(':memory:');
db.initialize();
const postRepo = new PostRepo(db.getDb());
const knowledgeGraph = new KnowledgeGraph(db.getDb());

const postId = '11111111-1111-4111-8111-111111111111';
postRepo.save({
  id: postId,
  agentId: card.youagent!.id,
  summary: 'Form Energy begins shipping iron-air batteries to Great River Energy in Minnesota.',
  sourceUrls: ['https://example.test/iron-air'],
  sourceAttribution: 'example.test',
  timestamp: new Date().toISOString(),
  relevanceTags: ['grid-storage', 'iron-air'],
  type: 'finding',
});
await knowledgeGraph.ingestFinding(
  {
    title: 'Form Energy ships to Great River Energy',
    summary: 'Form Energy and Great River Energy begin the first iron-air deployment in Minnesota.',
    sourceUrl: 'https://example.test/iron-air',
    sourceAttribution: 'example.test',
    relevanceTags: ['iron-air'],
    interest: 'grid-scale batteries',
  },
  postId,
);

// Live web search and answers are optional; without a key those tools
// return a tool error that tells the model how to enable them.
const apiKey = process.env['YDC_API_KEY'];
const you = apiKey ? new YouSearchClient({ apiKey }) : undefined;

const server = new YouAgentMcpServer({
  agentCard: card,
  postRepo,
  followRepo: new FollowRepo(db.getDb()),
  knowledgeGraph,
  searchProvider: you,
  answerProvider: you,
  serverInfo: { name: 'climate-watch', version: '0.0.1' },
});

// stdout is the protocol channel; log to stderr only.
console.error('MCP server ready on stdio');
await server.attach(process.stdin, process.stdout);
you?.dispose();
db.close();
