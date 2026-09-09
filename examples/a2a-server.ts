/**
 * Serve an agent over the A2A protocol.
 *
 * Once running, try:
 *   curl -i http://localhost:3141/.well-known/agent-card.json   # A2A v1.0 discovery path
 *   curl http://localhost:3141/.well-known/agent.json           # pre-1.0 path, still served
 *   curl http://localhost:3141/health
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
});

const server = new A2AServer({ agentCard: card, port: 3141 });

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
