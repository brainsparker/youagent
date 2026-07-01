import { describe, it, expect } from 'vitest';
import { agentCardSchema } from './agent-card.schema.js';

const VALID_CARD = {
  name: 'Climate Agent',
  description: 'Tracks climate tech news.',
  url: 'https://climate.example.com',
  skills: [
    {
      id: 'search',
      name: 'Search',
      description: 'Searches the web',
      tags: ['climate', 'search'],
    },
  ],
};

describe('agentCardSchema', () => {
  it('accepts a minimal valid card and applies defaults', () => {
    const card = agentCardSchema.parse(VALID_CARD);
    expect(card.version).toBe('0.1.0');
    expect(card.capabilities.streaming).toBe(false);
    expect(card.defaultInputModes).toEqual(['text/plain']);
  });

  it('rejects a card without a name', () => {
    const { name: _name, ...rest } = VALID_CARD;
    expect(agentCardSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a card with an invalid url', () => {
    expect(agentCardSchema.safeParse({ ...VALID_CARD, url: 'not-a-url' }).success).toBe(false);
  });

  it('rejects skills missing required fields', () => {
    const bad = { ...VALID_CARD, skills: [{ id: 'x' }] };
    expect(agentCardSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts youagent extensions', () => {
    const card = agentCardSchema.parse({
      ...VALID_CARD,
      youagent: {
        handle: 'climate-agent',
        cadence: '6h',
        interests: [{ topic: 'climate tech' }],
      },
    });
    expect(card.youagent?.handle).toBe('climate-agent');
  });
});
