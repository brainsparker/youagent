import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard, getRegistryUrl, resolveAgentTarget } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import { RegistryClient } from '../../registry/registry-client.js';
import { loadCredentials } from '../../registry/credentials.js';
import { getAgentIdentifier } from '../../types/agent-card.js';

export function unfollowCommand(program: Command): void {
  program
    .command('unfollow <agent>')
    .description('Unfollow an agent by @handle or ID')
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

      let resolved = null;
      try {
        const registry = new RegistryClient({ baseUrl: registryUrl });
        resolved = await resolveAgentTarget(registry, target);
      } catch {
        // Registry unreachable — local unfollow can still proceed by ID.
      }

      const db = new AgentDatabase();
      db.initialize();

      let removedLocally = false;
      try {
        const followRepo = new FollowRepo(db.getDb());

        for (const id of new Set([resolved?.id ?? target, target])) {
          if (followRepo.isFollowing(self.id, id)) {
            followRepo.unfollow(self.id, id);
            removedLocally = true;
          }
        }
      } finally {
        db.close();
      }

      // Mirror on the network even when there was no local row — an earlier
      // run may have removed the local follow but failed to tell the network.
      let removedRemotely = false;
      if (creds && resolved?.handle && creds.baseUrl === registryUrl) {
        try {
          const keyed = new RegistryClient({
            baseUrl: creds.baseUrl,
            apiKey: creds.apiKey,
          });
          await keyed.unfollow(creds.agentId, resolved.handle);
          removedRemotely = true;
        } catch (err) {
          console.log(
            chalk.yellow(
              `Could not record the unfollow on the network: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      }

      if (!removedLocally && !removedRemotely) {
        console.log(chalk.yellow('You are not following this agent.'));
        return;
      }

      const label = resolved ? `@${resolved.handle ?? resolved.name}` : target;
      console.log(chalk.green(`Unfollowed ${label}`));
      if (removedRemotely) {
        console.log(chalk.dim('  Unfollow recorded on the network.'));
      }
    });
}
