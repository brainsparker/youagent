import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import type { JsonWebKey } from 'node:crypto';
import { fetchVerifiedAgentCard, AgentCardDiscoveryError } from '../../a2a/discovery.js';
import {
  AgentCardSignatureError,
  decodeProtectedHeader,
  type JsonWebKeySet,
  type PublicKeyInput,
} from '../../a2a/card-signing.js';
import { getAgentUrl } from '../../types/agent-card.js';

/** Load a trusted public key from a PEM file, a JWK file or a JWK Set file. */
async function loadTrustedKeys(path: string): Promise<PublicKeyInput[]> {
  const text = await readFile(path, 'utf8');
  const trimmed = text.trim();
  if (trimmed.startsWith('-----BEGIN')) return [trimmed];
  const parsed = JSON.parse(trimmed) as JsonWebKey | JsonWebKeySet;
  if (Array.isArray((parsed as JsonWebKeySet).keys)) return (parsed as JsonWebKeySet).keys;
  return [parsed as JsonWebKey];
}

export function verifyCommand(program: Command): void {
  program
    .command('verify <agent-url>')
    .description("Fetch a remote agent's card and verify its A2A signatures (spec section 8.4)")
    .option(
      '-k, --key <path>',
      'Trusted public key: PEM, JWK or JWK Set file. Repeatable. With --key, the jku is not fetched unless --any-jku is also given.',
      (v: string, all: string[]) => [...all, v],
      [] as string[],
    )
    .option('--any-jku', 'Follow the signature jku to any origin, not only the origin the card came from')
    .option('--allow-unsigned', 'Exit 0 for an unsigned card instead of failing')
    .option('--json', 'Print the verification result as JSON')
    .action(async (agentUrl: string, opts: { key: string[]; anyJku?: boolean; allowUnsigned?: boolean; json?: boolean }) => {
      const keys: PublicKeyInput[] = [];
      for (const path of opts.key) keys.push(...(await loadTrustedKeys(path)));

      // Pinned keys mean "only these keys": no JWKS fetch unless --any-jku
      // widens it. Without pinned keys, the default same-origin policy applies.
      const jwks = opts.anyJku ? { origins: 'any' as const } : keys.length > 0 ? { origins: [] } : undefined;

      try {
        const { card, verification } = await fetchVerifiedAgentCard(agentUrl, {
          signature: {
            require: !opts.allowUnsigned,
            ...(keys.length > 0 ? { keys } : {}),
            ...(jwks ? { jwks } : {}),
          },
        });

        const signatureCount = card.signatures?.length ?? 0;
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                agentUrl,
                name: card.name,
                url: getAgentUrl(card),
                signatures: signatureCount,
                verified: verification !== undefined,
                verification: verification ?? null,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log('');
        console.log(chalk.bold('  Agent:       ') + card.name + chalk.dim(`  (${getAgentUrl(card)})`));
        if (!verification) {
          console.log(chalk.bold('  Signatures:  ') + chalk.yellow('none (unsigned card, accepted because --allow-unsigned)'));
          console.log('');
          return;
        }
        console.log(chalk.bold('  Signatures:  ') + `${signatureCount}`);
        console.log(
          chalk.bold('  Verified:    ') +
            chalk.green(`yes`) +
            chalk.dim(`  signature #${verification.index}, kid ${verification.kid}, ${verification.alg}`),
        );
        if (verification.jku) console.log(chalk.bold('  Key from:    ') + verification.jku);
        else console.log(chalk.bold('  Key from:    ') + 'trusted key store');
        for (const attempt of verification.attempts) {
          if (!attempt.ok) {
            console.log(chalk.dim(`  Skipped #${attempt.index}${attempt.kid ? ` (kid ${attempt.kid})` : ''}: ${attempt.reason ?? 'failed'}`));
          }
        }
        console.log('');
      } catch (err) {
        if (err instanceof AgentCardSignatureError) {
          if (opts.json) {
            console.log(JSON.stringify({ agentUrl, verified: false, code: err.code, message: err.message, attempts: err.attempts }, null, 2));
          } else {
            console.error(chalk.red(`Signature verification failed: ${err.message}`));
            for (const attempt of err.attempts) {
              const header = attempt.kid ? ` kid ${attempt.kid}, ${attempt.alg ?? '?'}` : '';
              console.error(chalk.dim(`  #${attempt.index}${header}: ${attempt.reason ?? 'failed'}`));
            }
            if (err.code === 'no_signatures') {
              console.error(chalk.dim('  Pass --allow-unsigned to accept unsigned cards.'));
            }
          }
          process.exit(1);
        }
        if (err instanceof AgentCardDiscoveryError) {
          console.error(chalk.red(err.message));
          process.exit(1);
        }
        throw err;
      }
    });
}

/** Exposed for tests and scripts: summarize a card's signature headers without verifying. */
export function describeSignatures(card: { signatures?: Array<{ protected: string; signature: string }> }): string[] {
  return (card.signatures ?? []).map((s, i) => {
    try {
      const h = decodeProtectedHeader(s);
      return `#${i} kid=${h.kid} alg=${h.alg}${h.jku ? ` jku=${h.jku}` : ''}`;
    } catch {
      return `#${i} malformed`;
    }
  });
}
