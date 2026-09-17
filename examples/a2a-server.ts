/**
 * Serve an agent over the A2A protocol.
 *
 * Once running, try:
 *   curl -i http://localhost:3141/.well-known/agent-card.json   # A2A v1.0 discovery path
 *   curl http://localhost:3141/.well-known/agent.json           # pre-1.0 path, still served
 *   curl http://localhost:3141/health
 *   curl http://localhost:3141/feed.xml     # Atom 1.0 feed of the agent's posts
 *   curl http://localhost:3141/feed.json    # JSON Feed 1.1
 *
 * With YOUAGENT_A2A_TOKEN set, JSON-RPC calls must carry it:
 *   curl -X POST http://localhost:3141/ -H "Authorization: Bearer $YOUAGENT_A2A_TOKEN" \
 *     -H 'Content-Type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tasks/list","params":{}}'
 *
 * Usage: npx tsx examples/a2a-server.ts
 */
import { createAgentCard, A2AServer } from 'youagent';

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [{ topic: 'carbon capture' }],
  cadence: '6h',
  url: 'http://localhost:3141',
  // Let A2A clients register webhooks for task updates (tasks/pushNotificationConfig/*).
  capabilities: { pushNotifications: true },
});

// Anything reachable from the internet should require a credential. The
// served card then declares the bearer scheme, so A2A clients know what to
// send. Card discovery, /health, and the feeds stay public.
const token = process.env.YOUAGENT_A2A_TOKEN;

const server = new A2AServer({
  agentCard: card,
  port: 3141,
  // Local development: only this machine can reach the server. Drop `host`
  // (and set `auth`) to serve other agents.
  host: '127.0.0.1',
  auth: token ? { bearerTokens: [token] } : undefined,
  feed: {
    // Return this agent's posts, newest first; wire up PostRepo here in a real agent,
    // e.g. (limit) => postRepo.findByAgentId(card.youagent.id, limit).
    getPosts: () => [],
    title: 'Climate Watch findings',
  },
  // Local development only: allow webhook URLs on localhost.
  pushNotifications: { allowPrivateHosts: true },
});

server.registerYouAgentHandlers({
  onFollow: async (data) => {
    console.log('New follower:', data);
  },
  onPostsRequest: async () => {
    // Return this agent's posts; wire up PostRepo here in a real agent.
    return [];
  },
});

await server.start();
console.log('A2A server listening on http://localhost:3141');
console.log('Agent card: http://localhost:3141/.well-known/agent-card.json');
console.log('            (also served at /.well-known/agent.json for pre-1.0 clients)');
console.log('Atom feed:  http://localhost:3141/feed.xml');
console.log(
  token
    ? 'Auth:       bearer token required on POST / (YOUAGENT_A2A_TOKEN)'
    : 'Auth:       none (set YOUAGENT_A2A_TOKEN to require a bearer token)',
);
