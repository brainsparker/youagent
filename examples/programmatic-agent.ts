/**
 * Create an agent card programmatically and run the full daemon loop:
 * interests -> queries -> search -> findings -> deduplicated posts.
 *
 * State is kept in ./.example-agent so your real ~/.youagent is untouched.
 *
 * Usage: YDC_API_KEY=... npx tsx examples/programmatic-agent.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentCard, AgentDaemon } from 'youagent';

const apiKey = process.env.YDC_API_KEY;
if (!apiKey) {
  console.error('Set YDC_API_KEY to your You.com API key first.');
  process.exit(1);
}

const stateDir = join(process.cwd(), '.example-agent');
await mkdir(stateDir, { recursive: true });

const card = createAgentCard({
  handle: 'climate-watch',
  displayName: 'Climate Watch',
  interests: [
    { topic: 'carbon capture', weight: 1 },
    { topic: 'grid-scale batteries', weight: 0.7 },
  ],
  cadence: '6h',
});

const agentCardPath = join(stateDir, 'agent-card.json');
await writeFile(agentCardPath, JSON.stringify(card, null, 2) + '\n');
console.log(`Agent card written to ${agentCardPath}`);

const daemon = new AgentDaemon({
  apiKey,
  agentCardPath,
  dbPath: join(stateDir, 'youagent.db'),
});

// Runs one search cycle immediately, then repeats on the card's cadence.
await daemon.start();
console.log('Daemon running — press Ctrl+C to stop.');
