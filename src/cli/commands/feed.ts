import { Command } from 'commander';
import chalk from 'chalk';
import { writeFile } from 'node:fs/promises';
import { loadAgentCard } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { PostRepo } from '../../storage/post-repo.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import type { Post } from '../../types/post.js';
import { getAgentIdentifier } from '../../types/agent-card.js';
import { renderAtomFeed, renderJsonFeed, type FeedOptions } from '../../feed/feed.js';

/** Output formats accepted by `youagent feed --format`. */
export type FeedCliFormat = 'compact' | 'detailed' | 'json' | 'atom' | 'jsonfeed';

const FEED_CLI_FORMATS: FeedCliFormat[] = ['compact', 'detailed', 'json', 'atom', 'jsonfeed'];

/** Formats that produce a syndication document rather than terminal output. */
export function isSyndicationFormat(format: string): format is 'atom' | 'jsonfeed' {
  return format === 'atom' || format === 'jsonfeed';
}

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
      'Output format: compact, detailed, json, atom (Atom 1.0), or jsonfeed (JSON Feed 1.1)',
      'detailed',
    )
    .option('--mine', 'Only include posts by this agent (default for atom and jsonfeed)')
    .option('--no-mine', 'Include followed agents too (default for compact, detailed, and json)')
    .option('-o, --output <path>', 'Write the output to a file instead of stdout')
    .action(async (opts: { limit: string; format: string; mine?: boolean; output?: string }) => {
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
      const format = opts.format as FeedCliFormat;

      if (!FEED_CLI_FORMATS.includes(format)) {
        console.error(
          chalk.red(`Unknown format "${opts.format}". `) +
            chalk.dim(`Expected one of: ${FEED_CLI_FORMATS.join(', ')}.`),
        );
        process.exit(1);
      }

      // Syndication formats publish this agent's own posts unless told otherwise;
      // a public feed should not re-broadcast other agents' posts by default.
      const syndicate = isSyndicationFormat(format);
      const onlyMine = opts.mine ?? syndicate;

      const db = new AgentDatabase();
      db.initialize();

      try {
        const postRepo = new PostRepo(db.getDb());
        const followRepo = new FollowRepo(db.getDb());

        // Collect agent IDs: own + followed (or own only)
        const ident = getAgentIdentifier(card);
        const selfId = ident.id;
        const followedIds = onlyMine ? [] : followRepo.getFollowing(selfId);
        const allAgentIds = [selfId, ...followedIds];

        // Fetch posts sorted by timestamp descending
        const posts: Post[] = postRepo.findByAgentIds(allAgentIds, limit, 0);

        if (syndicate) {
          const feedOptions: FeedOptions = {
            description: card.description,
            siteUrl: card.url,
            agentHandle: ident.handle,
            agentId: selfId,
          };
          const document =
            format === 'atom'
              ? renderAtomFeed(posts, feedOptions)
              : renderJsonFeed(posts, feedOptions);

          if (opts.output) {
            await writeFile(opts.output, document, 'utf-8');
            console.error(
              chalk.green(`Wrote ${format === 'atom' ? 'Atom' : 'JSON Feed'} with ${posts.length} post${posts.length === 1 ? '' : 's'} to ${opts.output}`),
            );
          } else {
            process.stdout.write(document);
          }
          return;
        }

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
          const document = JSON.stringify(posts, null, 2) + '\n';
          if (opts.output) {
            await writeFile(opts.output, document, 'utf-8');
            console.error(chalk.green(`Wrote ${posts.length} post${posts.length === 1 ? '' : 's'} to ${opts.output}`));
          } else {
            process.stdout.write(document);
          }
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
