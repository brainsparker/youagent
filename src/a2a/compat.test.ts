import { describe, expect, it } from 'vitest';
import {
  normalizeArtifact,
  normalizeMessage,
  normalizePart,
  normalizeTask,
} from './compat.js';

describe('normalizePart', () => {
  it('passes through spec-shaped kind parts', () => {
    expect(normalizePart({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(normalizePart({ kind: 'data', data: { a: 1 } })).toEqual({
      kind: 'data',
      data: { a: 1 },
    });
    expect(normalizePart({ kind: 'file', file: { uri: 'https://x.test/f' } })).toEqual({
      kind: 'file',
      file: { uri: 'https://x.test/f' },
    });
  });

  it('converts legacy type-discriminated parts to kind', () => {
    expect(normalizePart({ type: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(normalizePart({ type: 'data', data: { a: 1 } })).toEqual({
      kind: 'data',
      data: { a: 1 },
    });
  });

  it('strips the legacy type field from the normalized part', () => {
    const normalized = normalizePart({ type: 'text', text: 'hi' });
    expect('type' in normalized).toBe(false);
  });

  it('prefers kind when both discriminators are present', () => {
    expect(normalizePart({ kind: 'text', type: 'data', text: 'hi' })).toEqual({
      kind: 'text',
      text: 'hi',
    });
  });

  it('preserves metadata', () => {
    expect(normalizePart({ type: 'text', text: 'hi', metadata: { m: 1 } })).toEqual({
      kind: 'text',
      text: 'hi',
      metadata: { m: 1 },
    });
  });

  it('throws on unknown or missing discriminators', () => {
    expect(() => normalizePart({ text: 'hi' })).toThrow(/unknown kind/);
    expect(() => normalizePart({ kind: 'audio', text: 'hi' })).toThrow(/unknown kind/);
    expect(() => normalizePart(null)).toThrow(/expected an object/);
  });

  it('throws on structurally invalid parts', () => {
    expect(() => normalizePart({ kind: 'text' })).toThrow(/missing text/);
    expect(() => normalizePart({ kind: 'data' })).toThrow(/missing data/);
    expect(() => normalizePart({ kind: 'file' })).toThrow(/missing file/);
  });
});

describe('normalizeMessage', () => {
  it('adds the message kind discriminator and normalizes parts', () => {
    const message = normalizeMessage({
      role: 'user',
      messageId: 'm1',
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(message.kind).toBe('message');
    expect(message.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(message.messageId).toBe('m1');
  });

  it('rejects non-object messages', () => {
    expect(() => normalizeMessage('nope')).toThrow(/expected an object/);
  });
});

describe('normalizeArtifact', () => {
  it('keeps an existing artifactId', () => {
    const artifact = normalizeArtifact({
      artifactId: 'a1',
      parts: [{ kind: 'text', text: 'x' }],
    });
    expect(artifact.artifactId).toBe('a1');
  });

  it('generates an artifactId when a legacy peer omits it', () => {
    const artifact = normalizeArtifact({ parts: [{ type: 'text', text: 'x' }] });
    expect(artifact.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifact.parts).toEqual([{ kind: 'text', text: 'x' }]);
  });
});

describe('normalizeTask', () => {
  it('normalizes a legacy-shaped task end to end', () => {
    const task = normalizeTask({
      id: 't1',
      contextId: 'c1',
      status: {
        state: 'completed',
        timestamp: '2026-08-20T00:00:00.000Z',
        message: { role: 'agent', messageId: 'm2', parts: [{ type: 'text', text: 'done' }] },
      },
      history: [{ role: 'user', messageId: 'm1', parts: [{ type: 'text', text: 'go' }] }],
      artifacts: [{ name: 'posts', parts: [{ type: 'data', data: { posts: [] } }] }],
    });

    expect(task.kind).toBe('task');
    expect(task.status.message?.kind).toBe('message');
    expect(task.status.message?.parts[0]).toEqual({ kind: 'text', text: 'done' });
    expect(task.history?.[0].parts[0]).toEqual({ kind: 'text', text: 'go' });
    expect(task.artifacts?.[0].artifactId).toBeTruthy();
    expect(task.artifacts?.[0].parts[0]).toEqual({ kind: 'data', data: { posts: [] } });
  });

  it('passes through spec-shaped tasks unchanged apart from the discriminator', () => {
    const task = normalizeTask({
      kind: 'task',
      id: 't2',
      contextId: 'c2',
      status: { state: 'working', timestamp: '2026-08-20T00:00:00.000Z' },
    });
    expect(task).toMatchObject({ kind: 'task', id: 't2', contextId: 'c2' });
  });
});
