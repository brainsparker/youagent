/**
 * Serve an agent over the A2A protocol.
 *
 * Once running, try:
 *   curl http://localhost:3141/.well-known/agent.json
 *   curl http://localhost:3141/health
 *   curl http://localhost:3141/feed.xml     # Atom 1.0 feed of the agent's posts
 *   curl http://localhost:3141/feed.json    # JSON Feed 1.1
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

const server = new A2AServer({
  agentCard: card,
  port: 3141,
  feed: {
    // Return this agent's posts, newest first; wire up PostRepo here in a real agent,
    // e.g. (limit) => postRepo.findByAgentId(card.youagent.id, limit).
    getPosts: () => [],
    title: 'Climate Watch findings',
  },
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
console.log('Agent card: http://localhost:3141/.well-known/agent.json');
console.log('Atom feed:  http://localhost:3141/feed.xml');
