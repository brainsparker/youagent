import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getRegistryUrl } from '../utils.js';
import { RegistryClient, RegistryError } from '../../registry/registry-client.js';
import {
  loadCredentials,
  saveCredentials,
  getCredentialsPath,
} from '../../registry/credentials.js';
import type { AgentCard } from '../../types/agent-card.js';

/**
 * Trim card fields to the registry's validation limits so an oversized
 * local card degrades instead of failing registration with a 400.
 */
function clampCardForRegistration(card: AgentCard): AgentCard {
  return {
    ...card,
    name: card.name.slice(0, 120),
    description: card.description?.slice(0, 2000) ?? '',
    skills: card.skills.slice(0, 50).map((skill) => ({
      ...skill,
      tags: skill.tags.map((tag) => tag.slice(0, 80)),
    })),
    ...(card.youagent
      ? {
          youagent: {
            ...card.youagent,
            handle: card.youagent.handle.slice(0, 60),
            interests: card.youagent.interests
              .slice(0, 20)
              .map((interest) => ({ ...interest, topic: interest.topic.slice(0, 80) })),
          },
        }
      : {}),
  };
}

export function registerCommand(program: Command): void {
  program
    .command('register')
    .description('Register your agent with the For You network and store its bearer key')
    .option('--registry <url>', 'Registry base URL (or set YOUAGENT_REGISTRY_URL)')
    .action(async (opts: { registry?: string }) => {
      const card = await loadAgentCard();
      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const baseUrl = (opts.registry ?? (await getRegistryUrl())).replace(/\/+$/, '');

      const existing = await loadCredentials();
      if (existing) {
        if (existing.baseUrl === baseUrl) {
          console.log(
            chalk.yellow(`Already registered with ${baseUrl} as `) +
              chalk.cyan(`@${existing.handle}`) +
              chalk.yellow('.'),
          );
          console.log(
            chalk.dim(`  Run ${chalk.cyan('youagent key rotate')} to issue a fresh key.`),
          );
        } else {
          // Never overwrite: the stored key cannot be re-issued.
          console.error(
            chalk.red(`Already registered with ${existing.baseUrl} as `) +
              chalk.cyan(`@${existing.handle}`) +
              chalk.red('.'),
          );
          console.log(
            chalk.dim('  youagent keeps one network registration at a time. Run ') +
              chalk.cyan('youagent deregister') +
              chalk.dim(' first to leave that network.'),
          );
          process.exit(1);
        }
        return;
      }

      const registry = new RegistryClient({ baseUrl });

      console.log(chalk.dim(`Registering with ${baseUrl}...`));

      let registration;
      try {
        registration = await registry.register(clampCardForRegistration(card));
      } catch (err) {
        if (err instanceof RegistryError && err.statusCode === 409) {
          console.error(chalk.red('That handle is already registered on this network.'));
          console.log(
            chalk.dim('  If it is yours from a previous run, restore its stored key —'),
          );
          console.log(
            chalk.dim(`  otherwise change ${chalk.cyan('youagent.handle')} in your agent card and retry.`),
          );
        } else {
          console.error(
            chalk.red(`Registration failed: ${err instanceof Error ? err.message : err}`),
          );
        }
        process.exit(1);
      }

      if (!registration?.apiKey) {
        console.log(
          chalk.yellow('Registered, but the registry did not return a bearer key.'),
        );
        console.log(chalk.dim('  Keyed features (push, network search) will be unavailable.'));
        return;
      }

      const handle = registration.handle.replace(/^@/, '');
      try {
        await saveCredentials({
          baseUrl,
          agentId: registration.id,
          handle,
          apiKey: registration.apiKey,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        // The key is shown exactly once by the network — losing it here
        // would strand the registration, so hand it to the user instead.
        console.error(
          chalk.red(
            `Registered, but saving the key failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
        console.error('');
        console.error(chalk.yellow.bold('  Store this key now — it cannot be shown again:'));
        console.error(`  ${registration.apiKey}`);
        console.error('');
        console.error(
          chalk.dim(
            `  Write it to ${getCredentialsPath()} as:\n  ${JSON.stringify({
              baseUrl,
              agentId: registration.id,
              handle,
              apiKey: '<key>',
            })}`,
          ),
        );
        process.exit(1);
      }

      console.log('');
      console.log(chalk.green.bold('Registered!') + chalk.dim(` (${baseUrl})`));
      console.log('');
      console.log(chalk.dim('  Handle:   ') + chalk.cyan(`@${handle}`));
      console.log(chalk.dim('  Agent ID: ') + chalk.white(registration.id));
      console.log(
        chalk.dim('  Key:      ') +
          chalk.white(`saved to ${getCredentialsPath()} (0600)`),
      );
      console.log('');
      console.log(
        chalk.dim('  The key is shown only once by the network and is now stored locally.'),
      );
      console.log(
        chalk.dim(
          `  Your agent can now ${chalk.cyan('youagent push')} findings and search via the network — no You.com key needed.`,
        ),
      );
      console.log('');
    });
}
