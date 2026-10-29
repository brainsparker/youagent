import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getAgentCardPath, resolveSearchProvider } from '../utils.js';
import { AgentDaemon } from '../../daemon/agent-daemon.js';
import { AgentA2AService, DEFAULT_A2A_PORT } from '../../daemon/a2a-service.js';
import { loadCredentials } from '../../registry/credentials.js';
import { NetworkPusher } from '../../registry/pusher.js';
import { isYouAgent } from '../../types/agent-card.js';

export function startCommand(program: Command): void {
  program
    .command('start')
    .description('Start the agent daemon (runs in foreground)')
    .option('-k, --api-key <key>', 'You.com API key (or set YDC_API_KEY env var)')
    .option('--no-push', 'Do not push new posts to the network')
    .option(
      '--a2a-port <port>',
      `Port for the A2A server (0 picks a free port)`,
      String(DEFAULT_A2A_PORT),
    )
    .option('--no-a2a', 'Do not serve the agent over A2A')
    .action(async (opts: { apiKey?: string; push: boolean; a2aPort: string; a2a: boolean }) => {
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

      // Serve the agent over A2A (card discovery, feeds, social extensions)
      // unless disabled. A failed bind never stops the search daemon.
      let a2aService: AgentA2AService | null = null;
      if (opts.a2a) {
        const a2aPort = Number(opts.a2aPort);
        if (!Number.isInteger(a2aPort) || a2aPort < 0 || a2aPort > 65535) {
          console.error(
            chalk.red(`Invalid --a2a-port "${opts.a2aPort}". `) +
              chalk.dim('Expected an integer between 0 and 65535.'),
          );
          process.exit(1);
        }
        a2aService = new AgentA2AService({ agentCard: card, port: a2aPort });
        try {
          const boundPort = await a2aService.start();
          console.log(
            chalk.green(`A2A server listening on http://localhost:${boundPort}`),
          );
          console.log(
            chalk.dim(`  Agent card: http://localhost:${boundPort}/.well-known/agent-card.json`),
          );
          console.log(
            chalk.dim(
              `  Feeds:      http://localhost:${boundPort}/feed.xml (Atom) · http://localhost:${boundPort}/feed.json (JSON Feed)`,
            ),
          );
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          await a2aService.stop();
          a2aService = null;
          console.error(
            chalk.yellow(
              code === 'EADDRINUSE'
                ? `A2A server disabled: port ${a2aPort} is already in use.`
                : `A2A server disabled: ${err instanceof Error ? err.message : String(err)}`,
            ) + chalk.dim(' Searching still runs. Use --a2a-port <port> or --no-a2a.'),
          );
        }
      }

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('');
        console.log(chalk.yellow('Shutting down agent...'));
        if (a2aService) {
          await a2aService.stop();
        }
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
