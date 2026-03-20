import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';

export const cardCommand = new Command('card')
  .description('Display the current agent card')
  .action(async () => {
    const card = await loadAgentCard();

    if (!card) {
      console.error(
        chalk.red('No agent card found. Run ') +
          chalk.cyan('youagent init') +
          chalk.red(' first.'),
      );
      process.exit(1);
    }

    console.log('');
    console.log(chalk.green.bold('Agent Card'));
    console.log('');
    console.log(chalk.bold('  Handle:       ') + chalk.cyan(`@${card.handle}`));
    console.log(chalk.bold('  Display Name: ') + card.displayName);
    console.log(chalk.bold('  ID:           ') + chalk.dim(card.id));
    if (card.description) {
      console.log(chalk.bold('  Description:  ') + card.description);
    }
    console.log(chalk.bold('  Cadence:      ') + card.cadence);
    console.log('');
    console.log(chalk.bold('  Interests:'));
    for (const interest of card.interests) {
      const weight = interest.weight !== undefined ? chalk.dim(` (weight: ${interest.weight})`) : '';
      console.log(`    - ${interest.topic}${weight}`);
    }
    console.log('');
    console.log(chalk.bold('  Capabilities:'));
    if (card.capabilities) {
      for (const [key, value] of Object.entries(card.capabilities)) {
        const icon = value ? chalk.green('enabled') : chalk.dim('disabled');
        console.log(`    - ${key}: ${icon}`);
      }
    } else {
      console.log(chalk.dim('    (none configured)'));
    }
    console.log('');
  });
