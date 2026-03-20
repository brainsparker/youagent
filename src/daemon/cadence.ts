/**
 * Cadence parsing utility.
 *
 * Converts human-friendly shorthand cadence strings (e.g. '6h', '30m', '1d')
 * into cron expressions compatible with node-cron.
 */

import cron from 'node-cron';

// ---------------------------------------------------------------------------
// Shorthand patterns
// ---------------------------------------------------------------------------

const SHORTHAND_RE = /^(\d+)\s*(m|h|d)$/i;

/**
 * Convert a cadence shorthand string to a cron expression.
 *
 * Supported shorthands:
 * - `'30m'` -> `'*​/30 * * * *'`
 * - `'1h'`  -> `'0 * * * *'`
 * - `'6h'`  -> `'0 *​/6 * * *'`
 * - `'1d'`  -> `'0 0 * * *'`
 *
 * If the input already looks like a cron expression (contains spaces), it is
 * passed through unchanged after validation.
 *
 * @throws {Error} If the cadence string is invalid or the resulting cron
 *   expression fails validation.
 */
export function shorthandToCron(cadence: string): string {
  const trimmed = cadence.trim();

  // If it already contains spaces, treat it as a raw cron expression.
  if (trimmed.includes(' ')) {
    if (!cron.validate(trimmed)) {
      throw new Error(`Invalid cron expression: "${trimmed}"`);
    }
    return trimmed;
  }

  const match = trimmed.match(SHORTHAND_RE);
  if (!match) {
    throw new Error(
      `Invalid cadence shorthand: "${trimmed}". ` +
        'Expected a cron expression or shorthand like "30m", "1h", "6h", "1d".',
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  let expression: string;

  switch (unit) {
    case 'm': {
      if (value < 1 || value > 59) {
        throw new Error(`Minute cadence must be between 1 and 59, got ${value}.`);
      }
      expression = value === 1 ? '* * * * *' : `*/${value} * * * *`;
      break;
    }
    case 'h': {
      if (value < 1 || value > 23) {
        throw new Error(`Hour cadence must be between 1 and 23, got ${value}.`);
      }
      expression = value === 1 ? '0 * * * *' : `0 */${value} * * *`;
      break;
    }
    case 'd': {
      if (value < 1 || value > 28) {
        throw new Error(`Day cadence must be between 1 and 28, got ${value}.`);
      }
      expression = value === 1 ? '0 0 * * *' : `0 0 */${value} * *`;
      break;
    }
    default:
      throw new Error(`Unsupported cadence unit: "${unit}".`);
  }

  if (!cron.validate(expression)) {
    throw new Error(`Generated invalid cron expression: "${expression}" from cadence "${trimmed}".`);
  }

  return expression;
}
