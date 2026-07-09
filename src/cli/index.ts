#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import {
  initCommand,
  cardCommand,
  feedCommand,
  startCommand,
  stopCommand,
  followCommand,
  unfollowCommand,
  discoverCommand,
  respondCommand,
  searchCommand,
  askCommand,
  exportCommand,
  registerCommand,
  deregisterCommand,
  pushCommand,
  keyCommand,
} from './commands/index.js';

const program = new Command()
  .name('youagent')
  .description('CLI-first agent framework powered by You.com')
  .version('0.1.0');

// ── Implemented commands ─────────────────────────────────────────────────────

program.addCommand(initCommand);
program.addCommand(cardCommand);

// Register feed, start, stop as real commands
feedCommand(program);
startCommand(program);
stopCommand(program);

// Register follow graph commands
followCommand(program);
unfollowCommand(program);
discoverCommand(program);

// Register remaining commands
respondCommand(program);
searchCommand(program);
askCommand(program);
exportCommand(program);

// Register network commands
registerCommand(program);
deregisterCommand(program);
pushCommand(program);
keyCommand(program);

program.parse();
