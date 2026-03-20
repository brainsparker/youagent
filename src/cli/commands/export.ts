import { Command } from 'commander';
import chalk from 'chalk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAgentCard, getAgentDir } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { PostRepo } from '../../storage/post-repo.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import { KnowledgeGraph } from '../../knowledge/knowledge-graph.js';

export function exportCommand(program: Command): void {
  program
    .command('export')
    .description('Export agent card, posts, and knowledge graph as JSON')
    .option('-o, --output <path>', 'Output file path', 'youagent-export.json')
    .action(async (opts: { output: string }) => {
      const card = await loadAgentCard();
      if (!card) {
        console.log(chalk.red('No agent card found. Run `youagent init` first.'));
        process.exit(1);
      }

      const db = new AgentDatabase(join(getAgentDir(), 'youagent.db'));
      db.initialize();

      const postRepo = new PostRepo(db.getDb());
      const followRepo = new FollowRepo(db.getDb());
      const kg = new KnowledgeGraph(db.getDb());

      const posts = postRepo.findByAgentId(card.youagent.id, 1000);
      const following = followRepo.getFollowing(card.youagent.id);
      const followers = followRepo.getFollowers(card.youagent.id);
      const entities = kg.getAllEntities(1000);

      const exportData = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        agentCard: card,
        posts,
        followGraph: { following, followers },
        knowledgeGraph: { entities },
      };

      const outputPath = opts.output;
      await writeFile(outputPath, JSON.stringify(exportData, null, 2) + '\n', 'utf-8');

      console.log(chalk.green(`Exported to ${outputPath}`));
      console.log(chalk.dim(`  Agent: @${card.youagent.handle}`));
      console.log(chalk.dim(`  Posts: ${posts.length}`));
      console.log(chalk.dim(`  Following: ${following.length}`));
      console.log(chalk.dim(`  Knowledge entities: ${entities.length}`));

      db.close();
    });
}
