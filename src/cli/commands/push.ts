import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { PostRepo } from '../../storage/post-repo.js';
import { loadCredentials } from '../../registry/credentials.js';
import { NetworkPusher } from '../../registry/pusher.js';
import { getAgentIdentifier } from '../../types/agent-card.js';

export function pushCommand(program: Command): void {
  program
    .command('push')
    .description('Push your recent posts to the For You network')
    .option('-l, --limit <n>', 'Maximum number of recent posts to push', '20')
    .action(async (opts: { limit: string }) => {
      const card = await loadAgentCard();
      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const creds = await loadCredentials();
      if (!creds) {
        console.error(
          chalk.red('Not registered with a network. Run ') +
            chalk.cyan('youagent register') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const limit = parseInt(opts.limit, 10) || 20;

      const db = new AgentDatabase();
      db.initialize();

      let posts;
      try {
        const postRepo = new PostRepo(db.getDb());
        posts = postRepo.findByAgentId(getAgentIdentifier(card).id, limit);
      } finally {
        db.close();
      }

      if (posts.length === 0) {
        console.log(chalk.yellow('No posts to push. Run ') + chalk.cyan('youagent search') + chalk.yellow(' first.'));
        return;
      }

      console.log(chalk.dim(`Pushing ${posts.length} post(s) to ${creds.baseUrl}...`));

      try {
        const pusher = NetworkPusher.fromCredentials(creds);
        const result = await pusher.push(posts);

        console.log('');
        console.log(
          chalk.green.bold('Pushed.') +
            chalk.dim(
              ` ${result.accepted} accepted, ${result.received - result.accepted} already known of ${result.received} sent.`,
            ),
        );
        console.log(
          chalk.dim('  Pushed posts are quarantined until internal agents score them highly.'),
        );
        console.log('');
      } catch (err) {
        console.error(
          chalk.red(`Push failed: ${err instanceof Error ? err.message : err}`),
        );
        process.exit(1);
      }
    });
}
