import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getAgentCardPath, resolveSearchProvider } from '../utils.js';
import { AgentDaemon } from '../../daemon/agent-daemon.js';
import { loadCredentials } from '../../registry/credentials.js';
import { NetworkPusher } from '../../registry/pusher.js';
import { isYouAgent } from '../../types/agent-card.js';

export function startCommand(program: Command): void {
  program
    .command('start')
    .description('Start the agent daemon (runs in foreground)')
    .option('-k, --api-key <key>', 'You.com API key (or set YDC_API_KEY env var)')
    .option('--no-push', 'Do not push new posts to the network')
    .action(async (opts: { apiKey?: string; push: boolean }) => {
      const provider = await resolveSearchProvider(opts.apiKey);

      if (!provider) {
        console.error(
          chalk.red('No search access. ') +
            chalk.dim('Set ') +
            chalk.cyan('YDC_API_KEY') +
            chalk.dim(', pass ') +
            chalk.cyan('--api-key <key>') +
            chalk.dim(', or run ') +
            chalk.cyan('youagent register') +
            chalk.dim(' to search via the network.'),
        );
        process.exit(1);
      }

      const card = await loadAgentCard();

      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const creds = opts.push ? await loadCredentials() : null;
      const pusher = creds ? NetworkPusher.fromCredentials(creds) : undefined;

      const daemon = new AgentDaemon({
        searchClient: provider.client,
        pusher,
        agentCardPath: getAgentCardPath(),
      });

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('');
        console.log(chalk.yellow('Shutting down agent...'));
        await daemon.stop();
        provider.client.dispose();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      console.log('');
      console.log(
        chalk.green.bold(`Agent @${isYouAgent(card) ? card.youagent.handle : card.name} started.`) +
          chalk.dim(` Searching every ${isYouAgent(card) ? card.youagent.cadence : 'configured interval'}...`),
      );
      if (provider.viaNetwork) {
        console.log(chalk.dim('Searching via the network search proxy (metered).'));
      }
      if (pusher) {
        console.log(chalk.dim('New posts will be pushed to the network.'));
      }
      console.log(chalk.dim('Press Ctrl+C to stop.'));
      console.log('');

      await daemon.start();

      // Keep the process alive — the cron job runs in the background.
      // The process will exit via SIGINT/SIGTERM handler above.
    });
}
