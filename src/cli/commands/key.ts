import { Command } from 'commander';
import chalk from 'chalk';
import { RegistryClient } from '../../registry/registry-client.js';
import {
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  getCredentialsPath,
} from '../../registry/credentials.js';
import type { RegistryCredentials } from '../../registry/credentials.js';

async function requireCredentials(): Promise<RegistryCredentials> {
  const creds = await loadCredentials();
  if (!creds) {
    console.error(
      chalk.red('No network key found. Run ') +
        chalk.cyan('youagent register') +
        chalk.red(' first.'),
    );
    process.exit(1);
  }
  return creds;
}

/** Warn when the env override would keep serving a stale key after changes. */
function warnIfEnvKeySet(): void {
  if (process.env['YOUAGENT_REGISTRY_KEY']) {
    console.log(
      chalk.yellow('Warning: YOUAGENT_REGISTRY_KEY is set and overrides the stored key.'),
    );
    console.log(
      chalk.dim('  Update or unset it, or subsequent commands will keep using the old key.'),
    );
  }
}

export function keyCommand(program: Command): void {
  const key = program
    .command('key')
    .description('Manage the network bearer key issued on registration');

  key
    .command('show')
    .description('Show the stored key (masked) and its registration')
    .action(async () => {
      const creds = await requireCredentials();
      const masked =
        creds.apiKey.length > 16
          ? `${creds.apiKey.slice(0, 7)}…${creds.apiKey.slice(-4)}`
          : '(set)';

      console.log('');
      console.log(chalk.dim('  Registry: ') + chalk.white(creds.baseUrl));
      console.log(chalk.dim('  Handle:   ') + chalk.cyan(`@${creds.handle}`));
      console.log(chalk.dim('  Agent ID: ') + chalk.white(creds.agentId));
      console.log(chalk.dim('  Key:      ') + chalk.white(masked));
      if (creds.createdAt) {
        console.log(chalk.dim('  Issued:   ') + chalk.white(creds.createdAt));
      }
      console.log(chalk.dim(`  Stored at ${getCredentialsPath()}`));
      console.log('');
    });

  key
    .command('rotate')
    .description('Rotate the key — the old key stops working immediately')
    .action(async () => {
      const creds = await requireCredentials();
      const registry = new RegistryClient({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
      });

      let newKey: string;
      try {
        newKey = await registry.rotateKey(creds.agentId);
      } catch (err) {
        console.error(
          chalk.red(`Rotation failed: ${err instanceof Error ? err.message : err}`),
        );
        process.exit(1);
      }

      try {
        await saveCredentials({
          ...creds,
          apiKey: newKey,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        // The old key is already dead; the new one is shown exactly once.
        console.error(
          chalk.red(
            `Rotated on the network, but saving the new key failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
        console.error('');
        console.error(chalk.yellow.bold('  Store this key now — it cannot be shown again:'));
        console.error(`  ${newKey}`);
        console.error('');
        console.error(
          chalk.dim(`  Write it as the "apiKey" field of ${getCredentialsPath()}.`),
        );
        process.exit(1);
      }

      console.log(chalk.green('Key rotated and saved.'));
      warnIfEnvKeySet();
    });

  key
    .command('revoke')
    .description('Revoke the key on the network and delete it locally')
    .action(async () => {
      const creds = await requireCredentials();
      const registry = new RegistryClient({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
      });

      try {
        await registry.revokeKey(creds.agentId);
        await deleteCredentials();
        console.log(chalk.yellow('Key revoked and removed locally.'));
        console.log(
          chalk.dim('  The agent record remains on the network but can no longer'),
        );
        console.log(
          chalk.dim('  authenticate, and its handle stays reserved. To leave the'),
        );
        console.log(
          chalk.dim(`  network and free the handle, use ${chalk.cyan('youagent deregister')} instead.`),
        );
        warnIfEnvKeySet();
      } catch (err) {
        console.error(
          chalk.red(`Revocation failed: ${err instanceof Error ? err.message : err}`),
        );
        process.exit(1);
      }
    });
}
