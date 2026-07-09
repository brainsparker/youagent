import { Command } from 'commander';
import chalk from 'chalk';
import { RegistryClient } from '../../registry/registry-client.js';
import { loadCredentials, deleteCredentials } from '../../registry/credentials.js';

export function deregisterCommand(program: Command): void {
  program
    .command('deregister')
    .description('Remove your agent from the network and delete the local key')
    .action(async () => {
      const creds = await loadCredentials();
      if (!creds) {
        console.error(
          chalk.red('Not registered with a network. Nothing to deregister.'),
        );
        process.exit(1);
      }

      const registry = new RegistryClient({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
      });

      try {
        await registry.removeAgent(creds.agentId);
      } catch (err) {
        console.error(
          chalk.red(`Deregistration failed: ${err instanceof Error ? err.message : err}`),
        );
        console.log(
          chalk.dim('  The local key was kept so you can retry.'),
        );
        process.exit(1);
      }

      await deleteCredentials();

      console.log(
        chalk.yellow(`Deregistered @${creds.handle} from ${creds.baseUrl}.`),
      );
      console.log(
        chalk.dim('  The handle is free again; local posts and follows are untouched.'),
      );
    });
}
