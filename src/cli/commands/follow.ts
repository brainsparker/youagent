import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getRegistryUrl, resolveAgentTarget } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import { RegistryClient } from '../../registry/registry-client.js';
import { loadCredentials } from '../../registry/credentials.js';
import { getAgentIdentifier } from '../../types/agent-card.js';

export function followCommand(program: Command): void {
  program
    .command('follow <agent>')
    .description('Follow an agent by @handle or ID')
    .action(async (target: string) => {
      const card = await loadAgentCard();

      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const self = getAgentIdentifier(card);
      const creds = await loadCredentials();
      const registryUrl = await getRegistryUrl();

      // Resolve @handle / bare-handle / ID targets against the registry.
      let resolved = null;
      let registryReachable = true;
      try {
        const registry = new RegistryClient({ baseUrl: registryUrl });
        resolved = await resolveAgentTarget(registry, target);
      } catch {
        registryReachable = false;
      }

      if (!resolved && (target.startsWith('@') || !registryReachable)) {
        if (target.startsWith('@')) {
          console.error(
            chalk.red(`No agent ${target} found on ${registryUrl}.`),
          );
        } else {
          console.error(
            chalk.red('Could not reach the agent registry to resolve the target. Please try again later.'),
          );
        }
        process.exit(1);
      }

      const followId = resolved?.id ?? target;

      if (
        followId === self.id ||
        (resolved?.handle !== undefined &&
          (resolved.handle === self.handle || resolved.handle === creds?.handle))
      ) {
        console.error(chalk.red('You cannot follow yourself.'));
        process.exit(1);
      }

      const db = new AgentDatabase();
      db.initialize();

      try {
        const followRepo = new FollowRepo(db.getDb());

        const alreadyFollowing =
          followRepo.isFollowing(self.id, followId) ||
          followRepo.isFollowing(self.id, target);

        const displayLabel = resolved
          ? `@${resolved.handle ?? resolved.name}`
          : target;

        if (alreadyFollowing) {
          // Still mirror below — an earlier run may have failed to record
          // the follow on the network.
          console.log(chalk.yellow('You are already following this agent.'));
        } else {
          followRepo.follow(self.id, followId);
          console.log(chalk.green(`Now following ${displayLabel}`));
        }

        // Mirror the follow on the network when registered (the network's
        // A2A follow path is read-only; follows require the bearer key).
        // The key is only ever sent to the registry that issued it.
        if (creds && resolved?.handle) {
          if (creds.baseUrl !== registryUrl) {
            console.log(
              chalk.dim(
                `  Not mirrored: the target was resolved on ${registryUrl}, but you are registered with ${creds.baseUrl}.`,
              ),
            );
            return;
          }
          try {
            const keyed = new RegistryClient({
              baseUrl: creds.baseUrl,
              apiKey: creds.apiKey,
            });
            await keyed.follow(creds.agentId, resolved.handle);
            console.log(chalk.dim('  Follow recorded on the network.'));
          } catch (err) {
            console.log(
              chalk.yellow(
                `  Could not record the follow on the network: ${err instanceof Error ? err.message : err}`,
              ),
            );
            console.log(
              chalk.dim(`  Re-run ${chalk.cyan(`youagent follow @${resolved.handle}`)} to retry.`),
            );
          }
        }
      } finally {
        db.close();
      }
    });
}
