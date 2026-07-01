import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import { YouSearchClient } from '../../client/you-client.js';

export function searchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Run an ad-hoc search outside the regular cycle')
    .option('--api-key <key>', 'You.com API key (or set YDC_API_KEY)')
    .option('--limit <n>', 'Number of results', '5')
    .action(async (query: string, opts: { apiKey?: string; limit: string }) => {
      const apiKey = opts.apiKey ?? process.env['YDC_API_KEY'];
      if (!apiKey) {
        console.log(chalk.red('Missing API key. Set YDC_API_KEY or use --api-key.'));
        process.exit(1);
      }

      const client = new YouSearchClient({ apiKey });

      console.log(chalk.dim(`Searching: "${query}"...\n`));

      try {
        const results = await client.search(query, {
          numResults: parseInt(opts.limit, 10),
        });

        if (results.length === 0) {
          console.log(chalk.yellow('No results found.'));
          return;
        }

        for (const result of results) {
          console.log(chalk.bold(result.title));
          console.log(chalk.cyan(result.url));
          if (result.snippet) {
            console.log(chalk.dim(result.snippet.slice(0, 200)));
          }
          console.log();
        }
      } catch (err) {
        console.log(chalk.red(`Search failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      } finally {
        client.dispose();
      }
    });
}
