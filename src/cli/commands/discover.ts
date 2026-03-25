import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import { RegistryClient } from '../../registry/registry-client.js';
import { AgentDiscovery } from '../../registry/discovery.js';
import { getAgentIdentifier, getEffectiveInterests } from '../../types/agent-card.js';

export function discoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Discover suggested agents to follow based on your interests')
    .option('-l, --limit <n>', 'Maximum number of suggestions', '10')
    .action(async (opts: { limit: string }) => {
      const card = await loadAgentCard();

      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const interests = getEffectiveInterests(card);
      if (interests.length === 0) {
        console.log(
          chalk.yellow('Your agent card has no interests. Add interests to get suggestions.'),
        );
        return;
      }

      const limit = parseInt(opts.limit, 10) || 10;

      let candidates;
      try {
        const registry = new RegistryClient({
          baseUrl: process.env.YOUAGENT_REGISTRY_URL ?? 'https://registry.youagent.dev',
        });
        candidates = await registry.discover(interests, limit + 20);
      } catch {
        console.log(
          chalk.yellow('Could not reach the agent registry. Please try again later.'),
        );
        return;
      }

      // Filter out self.
      const selfId = getAgentIdentifier(card).id;
      candidates = candidates.filter((a) => getAgentIdentifier(a).id !== selfId);

      // Filter out agents we already follow.
      const db = new AgentDatabase();
      db.initialize();

      try {
        const followRepo = new FollowRepo(db.getDb());
        const following = new Set(followRepo.getFollowing(selfId));
        candidates = candidates.filter((a) => !following.has(getAgentIdentifier(a).id));
      } finally {
        db.close();
      }

      // Rank by interest overlap and trim to limit.
      candidates = AgentDiscovery.rankByRelevance(candidates, interests).slice(0, limit);

      if (candidates.length === 0) {
        console.log('');
        console.log(chalk.yellow('No new agents found matching your interests.'));
        console.log(chalk.dim('Try broadening your interests or check back later.'));
        console.log('');
        return;
      }

      console.log('');
      console.log(
        chalk.green.bold('Suggested agents') +
          chalk.dim(` (${candidates.length} result${candidates.length === 1 ? '' : 's'})`),
      );
      console.log('');

      for (const agent of candidates) {
        const overlap = AgentDiscovery.interestOverlap(card, agent);
        const overlapPct = Math.round(overlap * 100);
        const topics = getEffectiveInterests(agent).join(', ');

        console.log(
          chalk.cyan(`  @${getAgentIdentifier(agent).handle}`) +
            chalk.white(`  ${agent.name}`),
        );
        console.log(
          chalk.dim('    Interests: ') + chalk.white(topics),
        );
        console.log(
          chalk.dim('    Overlap:   ') + chalk.magenta(`${overlapPct}%`),
        );
        console.log('');
      }

      console.log(
        chalk.dim(`  Run ${chalk.cyan('youagent follow <agent-id>')} to follow an agent.`),
      );
      console.log('');
    });
}
