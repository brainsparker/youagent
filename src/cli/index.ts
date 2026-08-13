#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'node:module';
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

// Resolve the version from package.json at runtime so the CLI can never
// drift from the published version. The relative depth is identical in
// dev (src/cli/) and in the build output (dist/cli/).
const { version } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

const program = new Command()
  .name('youagent')
  .description('CLI-first agent framework powered by You.com')
  .version(version);

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
