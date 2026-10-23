import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { getAgentCardPath } from '../utils.js';
import {
  AgentCardFetchError,
  fetchAgentCardDocument,
  validateAgentCard,
  type CardDocumentSource,
  type CardIssue,
  type CardValidationReport,
} from '../../a2a/card-validation.js';

/**
 * Exit codes: 0 valid, 1 invalid (or warnings under --strict), 2 when the
 * document could not be read or is not an agent card at all.
 */
const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_UNUSABLE = 2;

interface ValidateOptions {
  json?: boolean;
  strict?: boolean;
  timeout?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function loadDocument(
  target: string | undefined,
  timeoutMs: number,
): Promise<{ document: unknown; label: string; source?: CardDocumentSource }> {
  if (target === '-') {
    const text = await readStdin();
    return { document: JSON.parse(text), label: 'stdin' };
  }
  if (target && /^https?:\/\//i.test(target)) {
    const { document, source } = await fetchAgentCardDocument(target, { timeoutMs });
    return { document, label: source.url, source };
  }
  const path = target ?? getAgentCardPath();
  const text = await readFile(path, 'utf-8');
  return { document: JSON.parse(text), label: path };
}

function printIssue(issue: CardIssue): void {
  const tag = issue.severity === 'error' ? chalk.red('error  ') : chalk.yellow('warning');
  console.log(`  ${tag} ${chalk.dim(issue.path)}  ${issue.message} ${chalk.dim(`[${issue.code}]`)}`);
}

function printReport(label: string, report: CardValidationReport, strict: boolean): void {
  console.log('');
  console.log(chalk.bold('Agent card: ') + label);
  if (report.kind === 'not-an-agent-card') {
    console.log(chalk.red('  Not an A2A agent card.'));
    console.log(chalk.dim(`  ${report.whyThisVersion}`));
    console.log('');
    return;
  }
  const { summary } = report;
  if (summary.name) {
    console.log(chalk.bold('  Name:         ') + summary.name + (summary.version ? chalk.dim(` v${summary.version}`) : ''));
  }
  console.log(
    chalk.bold('  Judged as:    ') +
      `A2A ${report.judgedAgainst} ` +
      chalk.dim(`(${report.versionSource}: ${report.whyThisVersion})`),
  );
  console.log(
    chalk.bold('  Endpoints:    ') +
      (summary.endpoints.length ? summary.endpoints.join(', ') : chalk.red('none')) +
      (summary.transitional ? chalk.dim(' (transitional card: 1.0 interfaces plus legacy url)') : ''),
  );
  console.log(
    chalk.bold('  Skills:       ') +
      `${summary.skillCount}` +
      (summary.hasYouAgentExtension ? chalk.dim('  youagent extension present') : '') +
      (summary.signed ? chalk.dim('  signed') : ''),
  );
  console.log('');

  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log(chalk.green('  Valid. No violations, no warnings.'));
    console.log('');
    return;
  }
  for (const issue of report.errors) printIssue(issue);
  for (const issue of report.warnings) printIssue(issue);
  console.log('');
  const errorWord = report.errors.length === 1 ? 'violation' : 'violations';
  const warningWord = report.warnings.length === 1 ? 'warning' : 'warnings';
  const verdict = report.valid && !(strict && report.warnings.length > 0) ? chalk.green('Valid') : chalk.red('Invalid');
  console.log(`  ${verdict}: ${report.errors.length} ${errorWord}, ${report.warnings.length} ${warningWord}` + (strict && report.warnings.length > 0 ? chalk.dim(' (warnings fail under --strict)') : ''));
  console.log('');
}

export const validateCommand = new Command('validate')
  .description('Check an A2A agent card for spec conformance (local card, file, URL, or stdin)')
  .argument(
    '[source]',
    'Agent base URL (well-known paths are probed), direct URL to a card .json, path to a file, or "-" for stdin. Defaults to your own card.',
  )
  .option('--json', 'Print the full report as JSON')
  .option('--strict', 'Treat warnings as failures (exit 1)')
  .option('--timeout <ms>', 'HTTP timeout per request in milliseconds', '10000')
  .addHelpText(
    'after',
    `
Exit codes:
  0  valid
  1  violations found (or warnings, with --strict)
  2  could not read the document, or it is not an agent card

Examples:
  youagent validate                                  # your own ~/.youagent/agent-card.json
  youagent validate https://agents.example.com       # probes /.well-known/agent-card.json then /.well-known/agent.json
  youagent validate ./card.json --strict --json      # CI gate with machine-readable output
  curl -s https://peer.test/.well-known/agent-card.json | youagent validate -`,
  )
  .action(async (target: string | undefined, opts: ValidateOptions) => {
    const timeoutMs = Number.parseInt(opts.timeout ?? '10000', 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.error(chalk.red('--timeout must be a positive number of milliseconds'));
      process.exit(EXIT_UNUSABLE);
    }

    let loaded: Awaited<ReturnType<typeof loadDocument>>;
    try {
      loaded = await loadDocument(target, timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: message, attempts: err instanceof AgentCardFetchError ? err.attempts : undefined }, null, 2));
      } else if (!target && /ENOENT/.test(message)) {
        console.error(chalk.red('No agent card found. Run ') + chalk.cyan('youagent init') + chalk.red(' first, or pass a file or URL.'));
      } else {
        console.error(chalk.red(message));
      }
      process.exit(EXIT_UNUSABLE);
    }

    const report = validateAgentCard(loaded.document, { source: loaded.source });

    if (opts.json) {
      console.log(JSON.stringify({ source: loaded.label, ...report }, null, 2));
    } else {
      printReport(loaded.label, report, opts.strict === true);
    }

    if (report.kind === 'not-an-agent-card') {
      process.exit(EXIT_UNUSABLE);
    }
    const failed = report.valid === false || (opts.strict === true && report.warnings.length > 0);
    process.exit(failed ? EXIT_INVALID : EXIT_VALID);
  });
