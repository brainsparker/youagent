import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getAgentDir } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { KnowledgeGraph } from '../../knowledge/knowledge-graph.js';
import { YouSearchClient } from '../../client/you-client.js';
import { join } from 'node:path';

export function askCommand(program: Command): void {
  program
    .command('ask <question>')
    .description('Ask your agent a question')
    .option('--api-key <key>', 'You.com API key (or set YOU_API_KEY)')
    .action(async (question: string, opts: { apiKey?: string }) => {
      const card = await loadAgentCard();
      if (!card) {
        console.log(chalk.red('No agent card found. Run `youagent init` first.'));
        process.exit(1);
      }

      const db = new AgentDatabase(join(getAgentDir(), 'youagent.db'));
      db.initialize();
      const kg = new KnowledgeGraph(db.getDb());

      // Search knowledge graph for relevant entities
      const entities = kg.queryEntities(question);

      if (entities.length > 0) {
        console.log(chalk.bold('\nFrom your knowledge graph:\n'));
        for (const entity of entities.slice(0, 5)) {
          const rels = kg.getRelationships(entity.id);
          console.log(chalk.cyan(`  ${entity.name}`) + chalk.dim(` (${entity.type})`));
          console.log(chalk.dim(`    First seen: ${entity.firstSeen}`));
          if (rels.length > 0) {
            console.log(chalk.dim(`    ${rels.length} connection(s)`));
          }
          console.log();
        }
      }

      // Also do a live search if API key available
      const apiKey = opts.apiKey ?? process.env['YOU_API_KEY'];
      if (apiKey) {
        const client = new YouSearchClient({ apiKey });
        try {
          console.log(chalk.dim('Searching the web...\n'));
          const answer = await client.answer(question);
          if (answer.answer) {
            console.log(chalk.bold('Live answer:\n'));
            console.log(answer.answer);
            console.log();
          }
        } catch {
          // Live search is best-effort
        } finally {
          client.dispose();
        }
      } else if (entities.length === 0) {
        console.log(chalk.yellow('No knowledge found. Set YOU_API_KEY for live search.'));
      }

      db.close();
    });
}
