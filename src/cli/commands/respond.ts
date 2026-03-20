import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getAgentDir } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { PostRepo } from '../../storage/post-repo.js';
import { YouSearchClient } from '../../client/you-client.js';
import { FindingExtractorImpl } from '../../engine/finding-extractor.js';
import { PostPublisher } from '../../engine/post-publisher.js';
import { RespondHandler } from '../../engine/respond-handler.js';
import { join } from 'node:path';

export function respondCommand(program: Command): void {
  program
    .command('respond <post-id>')
    .description('Investigate a post deeper and publish a Respond')
    .option('--api-key <key>', 'You.com API key (or set YOU_API_KEY)')
    .action(async (postId: string, opts: { apiKey?: string }) => {
      const card = await loadAgentCard();
      if (!card) {
        console.log(chalk.red('No agent card found. Run `youagent init` first.'));
        process.exit(1);
      }

      const apiKey = opts.apiKey ?? process.env['YOU_API_KEY'];
      if (!apiKey) {
        console.log(chalk.red('Missing API key. Set YOU_API_KEY or use --api-key.'));
        process.exit(1);
      }

      const db = new AgentDatabase(join(getAgentDir(), 'youagent.db'));
      db.initialize();

      const postRepo = new PostRepo(db.getDb());
      const searchClient = new YouSearchClient({ apiKey });
      const extractor = new FindingExtractorImpl(searchClient);
      const publisher = new PostPublisher(postRepo, card.id);
      const handler = new RespondHandler(searchClient, extractor, publisher, postRepo);

      console.log(chalk.dim('Investigating post ' + postId + '...'));

      try {
        const post = await handler.respond(postId);
        console.log(chalk.green('\nRespond published!'));
        console.log(chalk.bold(post.summary));
        console.log(chalk.dim(`Citing: ${post.cites}`));
        for (const url of post.sourceUrls) {
          console.log(chalk.cyan(`  → ${url}`));
        }
      } catch (err) {
        console.log(chalk.red(`Failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      } finally {
        searchClient.dispose();
        db.close();
      }
    });
}
