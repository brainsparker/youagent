import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import { RegistryClient } from '../../registry/registry-client.js';
import { getAgentIdentifier } from '../../types/agent-card.js';

export function followCommand(program: Command): void {
  program
    .command('follow <agent-id>')
    .description('Follow an agent by ID')
    .action(async (agentId: string) => {
      const card = await loadAgentCard();

      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      if (agentId === getAgentIdentifier(card).id) {
        console.error(chalk.red('You cannot follow yourself.'));
        process.exit(1);
      }

      const db = new AgentDatabase();
      db.initialize();

      try {
        const followRepo = new FollowRepo(db.getDb());

        if (followRepo.isFollowing(getAgentIdentifier(card).id, agentId)) {
          console.log(chalk.yellow('You are already following this agent.'));
          return;
        }

        followRepo.follow(getAgentIdentifier(card).id, agentId);

        // Try to fetch agent info from the registry for a friendlier message.
        let displayLabel = agentId;
        try {
          const registry = new RegistryClient({
            baseUrl: process.env.YOUAGENT_REGISTRY_URL ?? 'https://registry.youagent.dev',
          });
          const remote = await registry.getAgent(agentId);
          if (remote) {
            displayLabel = `@${remote.youagent?.handle ?? remote.name}`;
          }
        } catch {
          // Registry unavailable — fall back to raw ID.
        }

        console.log(chalk.green(`Now following ${displayLabel}`));
      } finally {
        db.close();
      }
    });
}
