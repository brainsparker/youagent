import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getAgentCardPath } from '../utils.js';
import { AgentDaemon } from '../../daemon/agent-daemon.js';
import { isYouAgent } from '../../types/agent-card.js';

export function startCommand(program: Command): void {
  program
    .command('start')
    .description('Start the agent daemon (runs in foreground)')
    .option('-k, --api-key <key>', 'You.com API key (or set YOU_API_KEY env var)')
    .action(async (opts: { apiKey?: string }) => {
      const apiKey = opts.apiKey ?? process.env['YOU_API_KEY'];

      if (!apiKey) {
        console.error(
          chalk.red('Missing API key. ') +
            chalk.dim('Set ') +
            chalk.cyan('YOU_API_KEY') +
            chalk.dim(' env var or pass ') +
            chalk.cyan('--api-key <key>') +
            chalk.dim('.'),
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

      const daemon = new AgentDaemon({
        apiKey,
        agentCardPath: getAgentCardPath(),
      });

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('');
        console.log(chalk.yellow('Shutting down agent...'));
        await daemon.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      console.log('');
      console.log(
        chalk.green.bold(`Agent @${isYouAgent(card) ? card.youagent.handle : card.name} started.`) +
          chalk.dim(` Searching every ${isYouAgent(card) ? card.youagent.cadence : 'configured interval'}...`),
      );
      console.log(chalk.dim('Press Ctrl+C to stop.'));
      console.log('');

      await daemon.start();

      // Keep the process alive — the cron job runs in the background.
      // The process will exit via SIGINT/SIGTERM handler above.
    });
}
