import { Command } from 'commander';
import chalk from 'chalk';
import { loadAgentCard } from '../utils.js';
import {
  isYouAgent,
  getAgentIdentifier,
  getEffectiveInterests,
  getPrimaryInterface,
  normalizeAgentCard,
  toV1AgentCard,
} from '../../types/agent-card.js';
import type { AgentCard } from '../../types/agent-card.js';

export const cardCommand = new Command('card')
  .description('Display the current agent card')
  .option('--json', 'Print the card as JSON (A2A v1.0 structure plus legacy url/protocolVersion)')
  .option('--v1', 'With --json: strict A2A v1.0 output, legacy top-level fields removed')
  .action(async (opts: { json?: boolean; v1?: boolean }) => {
    const stored = await loadAgentCard();

    if (!stored) {
      console.error(
        chalk.red('No agent card found. Run ') +
          chalk.cyan('youagent init') +
          chalk.red(' first.'),
      );
      process.exit(1);
    }

    // Cards saved before A2A v1.0 support lack supportedInterfaces; upgrade
    // in memory so the display and JSON output are always v1.0-shaped.
    const card = normalizeAgentCard(stored) as AgentCard;

    if (opts.json) {
      const output = opts.v1 ? toV1AgentCard(card) : card;
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log('');
    console.log(chalk.green.bold('Agent Card'));
    console.log('');
    const ident = getAgentIdentifier(card);
    console.log(chalk.bold('  Handle:       ') + chalk.cyan(`@${ident.handle}`));
    console.log(chalk.bold('  Display Name: ') + card.name);
    console.log(chalk.bold('  ID:           ') + chalk.dim(ident.id));
    if (card.description) {
      console.log(chalk.bold('  Description:  ') + card.description);
    }
    console.log(chalk.bold('  Version:      ') + card.version);
    if (isYouAgent(card)) {
      console.log(chalk.bold('  Cadence:      ') + card.youagent.cadence);
    }
    console.log('');
    console.log(chalk.bold('  Interests:'));
    if (isYouAgent(card)) {
      for (const interest of card.youagent.interests) {
        const weight = interest.weight !== undefined ? chalk.dim(` (weight: ${interest.weight})`) : '';
        console.log(`    - ${interest.topic}${weight}`);
      }
    } else {
      for (const topic of getEffectiveInterests(card)) {
        console.log(`    - ${topic}`);
      }
    }
    console.log('');
    console.log(chalk.bold('  A2A interfaces:'));
    const interfaces = card.supportedInterfaces?.length
      ? card.supportedInterfaces
      : [getPrimaryInterface(card)].filter((i): i is NonNullable<typeof i> => i !== undefined);
    if (interfaces.length === 0) {
      console.log(chalk.dim('    (none declared)'));
    }
    interfaces.forEach((iface, index) => {
      const preferred = index === 0 ? chalk.dim(' (preferred)') : '';
      console.log(
        `    - ${iface.url}  ${chalk.dim(`${iface.protocolBinding} v${iface.protocolVersion}`)}${preferred}`,
      );
    });
    console.log('');
    console.log(chalk.bold('  Capabilities:'));
    if (card.capabilities) {
      for (const [key, value] of Object.entries(card.capabilities)) {
        if (key === 'extensions') {
          const extensions = Array.isArray(value) ? value : [];
          console.log(`    - extensions: ${extensions.length === 0 ? chalk.dim('none') : extensions.map((e) => e.uri).join(', ')}`);
          continue;
        }
        const icon = value ? chalk.green('enabled') : chalk.dim('disabled');
        console.log(`    - ${key}: ${icon}`);
      }
    } else {
      console.log(chalk.dim('    (none configured)'));
    }
    console.log('');
  });
