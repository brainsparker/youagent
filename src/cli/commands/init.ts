import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createAgentCard } from '../../schema/agent-card.schema.js';
import { slugify, saveAgentCard, getAgentCardPath } from '../utils.js';
import type { AgentCard } from '../../types/agent-card.js';

/**
 * Parse a natural-language description into a list of interest topics.
 * Splits on commas and common conjunctions like "and".
 */
function extractInterests(text: string): string[] {
  return text
    .split(/,|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Derive a display name from the list of interests.
 */
function deriveDisplayName(interests: string[]): string {
  if (interests.length === 1) {
    return `${interests[0]} Agent`;
  }
  return `${interests[0]} & More Agent`;
}

export const initCommand = new Command('init')
  .description('Initialize a new YouAgent with an agent card')
  .argument('[description]', 'Natural-language description of your interests')
  .action(async (description?: string) => {
    let descriptionText = description;

    if (!descriptionText) {
      const rl = createInterface({ input, output });
      try {
        descriptionText = await rl.question(
          chalk.cyan('Describe your interests (comma-separated): '),
        );
      } finally {
        rl.close();
      }
    }

    if (!descriptionText || descriptionText.trim().length === 0) {
      console.error(chalk.red('No interests provided. Aborting.'));
      process.exit(1);
    }

    const topics = extractInterests(descriptionText);

    if (topics.length === 0) {
      console.error(chalk.red('Could not extract any interests. Aborting.'));
      process.exit(1);
    }

    const handle = slugify(topics[0]);
    // Ensure handle meets minimum length requirement (3 chars)
    const safeHandle = handle.length < 3 ? handle.padEnd(3, '-') : handle;
    const displayName = deriveDisplayName(topics);

    const interests = topics.map((topic) => ({ topic, weight: 1 }));

    let card: AgentCard;
    try {
      card = createAgentCard({
        handle: safeHandle,
        displayName,
        description: descriptionText.trim(),
        interests,
        cadence: '6h',
        capabilities: {
          search: true,
          respond: true,
          crossReference: false,
        },
      });
    } catch (err) {
      console.error(chalk.red('Failed to create agent card:'), err);
      process.exit(1);
    }

    await saveAgentCard(card);

    console.log('');
    console.log(chalk.green.bold('Agent card created!'));
    console.log('');
    console.log(chalk.bold('  Handle:       ') + chalk.cyan(`@${card.handle}`));
    console.log(chalk.bold('  Display Name: ') + card.displayName);
    console.log(chalk.bold('  ID:           ') + chalk.dim(card.id));
    console.log(chalk.bold('  Cadence:      ') + card.cadence);
    console.log(chalk.bold('  Interests:    ') + card.interests.map((i) => i.topic).join(', '));
    console.log(
      chalk.bold('  Capabilities: ') +
        Object.entries(card.capabilities ?? {})
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', '),
    );
    console.log('');
    console.log(chalk.dim(`  Saved to ${getAgentCardPath()}`));
  });
