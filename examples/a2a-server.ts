/**
 * Serve an agent over the A2A protocol.
 *
 * Once running, try:
 *   curl -i http://localhost:3141/.well-known/agent-card.json   # A2A v1.0 discovery path
 *   curl http://localhost:3141/.well-known/agent.json           # pre-1.0 path, still served
 *   curl http://localhost:3141/health
 *   curl http://localhost:3141/feed.xml     # Atom 1.0 feed of the agent's posts
 *   curl http://localhost:3141/feed.json    # JSON Feed 1.1
 *   curl http://localhost:3141/.well-known/jwks.json  # public key the card is signed with
 *   youagent verify http://localhost:3141   # verify the served card's signature
 *
 * Usage: npx tsx examples/a2a-server.ts
 */
import { createAgentCard, A2AServer, generateCardSigningKeyPair } from 'youagent';

// A fresh key per run is fine for a demo. A real agent loads a persistent
// private key (PEM or JWK) and keeps the kid stable across restarts so
// clients can pin it.
const signingKey = generateCardSigningKeyPair('ES256');

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [{ topic: 'carbon capture' }],
  cadence: '6h',
  url: 'http://localhost:3141',
  // Let A2A clients register webhooks for task updates (tasks/pushNotificationConfig/*).
  capabilities: { pushNotifications: true },
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
  // Local development only: allow webhook URLs on localhost.
  pushNotifications: { allowPrivateHosts: true },
  // Sign the served card (A2A spec section 8.4) and publish the public key
  // at /.well-known/jwks.json so clients can verify it.
  signing: { key: signingKey.privateKey, kid: 'demo-key-1' },
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
