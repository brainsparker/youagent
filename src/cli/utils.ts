import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCard } from '../types/agent-card.js';

/**
 * Returns the path to the ~/.youagent directory.
 */
export function getAgentDir(): string {
  return join(homedir(), '.youagent');
}

/**
 * Returns the path to ~/.youagent/agent-card.json.
 */
export function getAgentCardPath(): string {
  return join(getAgentDir(), 'agent-card.json');
}

/**
 * Reads and parses the agent card from disk.
 * Returns null if the file does not exist.
 */
export async function loadAgentCard(): Promise<AgentCard | null> {
  try {
    const raw = await readFile(getAgentCardPath(), 'utf-8');
    return JSON.parse(raw) as AgentCard;
  } catch {
    return null;
  }
}

/**
 * Writes an agent card to ~/.youagent/agent-card.json.
 * Creates the directory if it does not exist.
 */
export async function saveAgentCard(card: AgentCard): Promise<void> {
  const dir = getAgentDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getAgentCardPath(), JSON.stringify(card, null, 2) + '\n', 'utf-8');
}

/**
 * Converts text to a URL-safe handle (lowercase, alphanumeric + hyphens).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
