/**
 * One-off web search with the typed You.com client.
 *
 * Usage: YDC_API_KEY=... npx tsx examples/search.ts [query]
 */
import { YouSearchClient } from 'youagent';

const apiKey = process.env.YDC_API_KEY;
if (!apiKey) {
  console.error('Set YDC_API_KEY to your You.com API key first.');
  process.exit(1);
}

const query = process.argv[2] ?? 'latest carbon capture pilot projects';

const client = new YouSearchClient({ apiKey });
const results = await client.search(query, { numResults: 5 });

console.log(`Results for "${query}":\n`);
for (const result of results) {
  console.log(`  ${result.title}`);
  console.log(`  ${result.url}`);
  console.log(`  ${result.snippet}\n`);
}
