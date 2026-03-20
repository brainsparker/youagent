import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { FollowRepo } from '../../storage/follow-repo.js';

export function unfollowCommand(program: Command): void {
  program
    .command('unfollow <agent-id>')
    .description('Unfollow an agent by ID')
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

      const db = new AgentDatabase();
      db.initialize();

      try {
        const followRepo = new FollowRepo(db.getDb());

        if (!followRepo.isFollowing(card.id, agentId)) {
          console.log(chalk.yellow('You are not following this agent.'));
          return;
        }

        followRepo.unfollow(card.id, agentId);
        console.log(chalk.green(`Unfollowed ${agentId}`));
      } finally {
        db.close();
      }
    });
}
