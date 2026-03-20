import { Command } from 'commander';
import chalk from 'chalk';

export function stopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop the agent daemon')
    .action(() => {
      console.log('');
      console.log(
        chalk.yellow('The agent daemon runs in the foreground (V1).'),
      );
      console.log(
        chalk.dim('Use ') +
          chalk.cyan('Ctrl+C') +
          chalk.dim(' in the terminal where ') +
          chalk.cyan('youagent start') +
          chalk.dim(' is running to stop it.'),
      );
      console.log('');
    });
}
