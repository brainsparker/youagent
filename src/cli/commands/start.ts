import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getAgentCardPath, resolveSearchProvider } from '../utils.js';
import { AgentDaemon } from '../../daemon/agent-daemon.js';
import type { DaemonServeConfig } from '../../daemon/agent-daemon.js';
import { loadCredentials } from '../../registry/credentials.js';
import { NetworkPusher } from '../../registry/pusher.js';
import { isYouAgent } from '../../types/agent-card.js';

interface StartOptions {
  apiKey?: string;
  push: boolean;
  serve: boolean;
  port?: number;
  publicUrl?: string;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError('Port must be an integer between 0 and 65535.');
  }
  return port;
}

function parseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('scheme');
    }
  } catch {
    throw new InvalidArgumentError('Public URL must be an absolute http or https URL.');
  }
  return value.replace(/\/+$/, '');
}

export function startCommand(program: Command): void {
  program
    .command('start')
    .description('Start the agent daemon (runs in foreground) and serve it over A2A')
    .option('-k, --api-key <key>', 'You.com API key (or set YDC_API_KEY env var)')
    .option('--no-push', 'Do not push new posts to the network')
    .option('--no-serve', 'Run search cycles only; do not serve the agent over A2A')
    .option('-p, --port <port>', 'Port for the A2A server (default: the port in the agent card URL, or 3141)', parsePort)
    .option(
      '--public-url <url>',
      'Public base URL peers should use to reach this agent (for example behind a reverse proxy)',
      parseUrl,
    )
    .action(async (opts: StartOptions) => {
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

      let serve: DaemonServeConfig | undefined;
      if (opts.serve) {
        serve = {};
        if (opts.port !== undefined) serve.port = opts.port;
        if (opts.publicUrl) serve.publicUrl = opts.publicUrl;
      }

      const daemon = new AgentDaemon({
        searchClient: provider.client,
        pusher,
        agentCardPath: getAgentCardPath(),
        serve,
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

      try {
        await daemon.start();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'EADDRINUSE' || code === 'EACCES') {
          const port = serve?.port ?? 'the agent card port';
          console.error(
            chalk.red(`Could not bind the A2A server on ${port} (${code}). `) +
              chalk.dim('Pass ') +
              chalk.cyan('--port <port>') +
              chalk.dim(' to use another port, or ') +
              chalk.cyan('--no-serve') +
              chalk.dim(' to run search cycles only.'),
          );
        } else {
          console.error(chalk.red(`Agent failed to start: ${err instanceof Error ? err.message : String(err)}`));
        }
        provider.client.dispose();
        process.exit(1);
      }

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
      const serving = daemon.serving;
      if (serving) {
        console.log(chalk.dim('Serving over A2A on port ') + chalk.cyan(String(serving.port)));
        console.log(chalk.dim('  Agent card: ') + chalk.cyan(serving.cardUrl));
        console.log(chalk.dim('  Atom feed:  ') + chalk.cyan(serving.atomFeedUrl));
        console.log(chalk.dim('  JSON Feed:  ') + chalk.cyan(serving.jsonFeedUrl));
        console.log(chalk.dim('  Tasks and webhooks persist in the agent database across restarts.'));
      } else {
        console.log(chalk.dim('Not serving over A2A (--no-serve).'));
      }
      console.log(chalk.dim('Press Ctrl+C to stop.'));
      console.log('');

      // Keep the process alive: the cron job and the A2A server run in the
      // background. The process exits via the SIGINT/SIGTERM handler above.
    });
}
