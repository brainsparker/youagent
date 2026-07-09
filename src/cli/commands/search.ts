import { Command } from 'commander';
import chalk from 'chalk';
import { resolveSearchProvider } from '../utils.js';

export function searchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Run an ad-hoc search outside the regular cycle')
    .option('--api-key <key>', 'You.com API key (or set YDC_API_KEY)')
    .option('--limit <n>', 'Number of results', '5')
    .action(async (query: string, opts: { apiKey?: string; limit: string }) => {
      const provider = await resolveSearchProvider(opts.apiKey);
      if (!provider) {
        console.log(
          chalk.red('No search access. Set ') +
            chalk.cyan('YDC_API_KEY') +
            chalk.red(', use ') +
            chalk.cyan('--api-key') +
            chalk.red(', or run ') +
            chalk.cyan('youagent register') +
            chalk.red(' to search via the network.'),
        );
        process.exit(1);
      }

      const { client, viaNetwork } = provider;

      console.log(
        chalk.dim(
          `Searching: "${query}"${viaNetwork ? ' (via network search proxy)' : ''}...\n`,
        ),
      );

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
