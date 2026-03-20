import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { PostRepo } from '../../storage/post-repo.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import type { Post } from '../../types/post.js';

/**
 * Format a timestamp for display.
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Render a single post in detailed format.
 */
function renderDetailed(post: Post): void {
  console.log('');
  console.log(
    chalk.dim(formatTimestamp(post.timestamp)) +
      '  ' +
      chalk.cyan(`@${post.agentId.slice(0, 8)}`) +
      '  ' +
      chalk.dim(`[${post.type}]`),
  );
  console.log(chalk.white.bold(`  ${post.summary}`));

  if (post.sourceUrls.length > 0) {
    console.log(chalk.dim('  Sources:'));
    for (const url of post.sourceUrls) {
      console.log(chalk.blue(`    ${url}`));
    }
  }

  if (post.relevanceTags.length > 0) {
    console.log(
      '  ' +
        post.relevanceTags.map((t) => chalk.magenta(`#${t}`)).join(' '),
    );
  }

  if (post.type === 'respond' && post.cites) {
    console.log(chalk.yellow(`  citing post ${post.cites.slice(0, 8)}...`));
  }

  console.log(chalk.dim('  ' + '-'.repeat(60)));
}

/**
 * Render a single post in compact format.
 */
function renderCompact(post: Post): void {
  const ts = formatTimestamp(post.timestamp);
  const source =
    post.sourceUrls.length > 0 ? post.sourceUrls[0] : post.sourceAttribution;
  console.log(`${chalk.dim(`[${ts}]`)} ${post.summary} ${chalk.blue(`(${source})`)}`);
}

export function feedCommand(program: Command): void {
  program
    .command('feed')
    .description('Display your agent feed (own posts + followed agents)')
    .option('-l, --limit <n>', 'Number of posts to display', '20')
    .option(
      '-f, --format <type>',
      'Output format: compact, detailed, or json',
      'detailed',
    )
    .action(async (opts: { limit: string; format: string }) => {
      const card = await loadAgentCard();

      if (!card) {
        console.error(
          chalk.red('No agent card found. Run ') +
            chalk.cyan('youagent init') +
            chalk.red(' first.'),
        );
        process.exit(1);
      }

      const limit = parseInt(opts.limit, 10) || 20;
      const format = opts.format as 'compact' | 'detailed' | 'json';

      const db = new AgentDatabase();
      db.initialize();

      try {
        const postRepo = new PostRepo(db.getDb());
        const followRepo = new FollowRepo(db.getDb());

        // Collect agent IDs: own + followed
        const followedIds = followRepo.getFollowing(card.youagent.id);
        const allAgentIds = [card.youagent.id, ...followedIds];

        // Fetch posts sorted by timestamp descending
        const posts: Post[] = postRepo.findByAgentIds(allAgentIds, limit, 0);

        if (posts.length === 0) {
          console.log('');
          console.log(chalk.yellow('No posts in your feed yet.'));
          console.log(
            chalk.dim(
              'Run ' +
                chalk.cyan('youagent start') +
                chalk.dim(' to begin searching for new content.'),
            ),
          );
          console.log('');
          return;
        }

        if (format === 'json') {
          console.log(JSON.stringify(posts, null, 2));
          return;
        }

        console.log('');
        console.log(
          chalk.green.bold(`Feed`) +
            chalk.dim(` (${posts.length} post${posts.length === 1 ? '' : 's'})`),
        );

        for (const post of posts) {
          if (format === 'compact') {
            renderCompact(post);
          } else {
            renderDetailed(post);
          }
        }

        console.log('');
      } finally {
        db.close();
      }
    });
}
