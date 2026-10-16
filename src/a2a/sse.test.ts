import { describe, it, expect } from 'vitest';
import { SseParser, formatSseComment, formatSseEvent, parseSseStream } from './sse.js';

describe('formatSseEvent', () => {
  it('emits data lines terminated by a blank line', () => {
    expect(formatSseEvent('{"a":1}')).toBe('data: {"a":1}\n\n');
  });

  it('adds id and event fields and splits multi-line payloads', () => {
    expect(formatSseEvent('one\ntwo', { id: 7, event: 'task' })).toBe(
      'id: 7\nevent: task\ndata: one\ndata: two\n\n',
    );
  });

  it('formats comments for heartbeats', () => {
    expect(formatSseComment('keep-alive')).toBe(': keep-alive\n\n');
  });
});

describe('SseParser', () => {
  it('round-trips formatted events; the last event id persists until replaced, as the spec requires', () => {
    const parser = new SseParser();
    const wire = formatSseEvent('{"x":1}', { id: 1 }) + formatSseEvent('a\nb', { event: 'custom' });
    expect(parser.push(wire)).toEqual([
      { id: '1', data: '{"x":1}' },
      { id: '1', event: 'custom', data: 'a\nb' },
    ]);
    expect(parser.push(formatSseEvent('next', { id: 2 }))).toEqual([{ id: '2', data: 'next' }]);
  });

  it('keeps partial lines across chunk boundaries', () => {
    const parser = new SseParser();
    expect(parser.push('data: hel')).toEqual([]);
    expect(parser.push('lo\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ data: 'hello' }]);
  });

  it('ignores comment lines and unknown fields, and accepts CRLF', () => {
    const parser = new SseParser();
    expect(parser.push(': ping\r\nretry: 5000\r\ndata:x\r\n\r\n')).toEqual([{ data: 'x' }]);
  });

  it('does not emit an event for a blank line without data', () => {
    const parser = new SseParser();
    expect(parser.push('event: noop\n\n')).toEqual([]);
  });

  it('flushes a trailing unterminated event on end()', () => {
    const parser = new SseParser();
    expect(parser.push('data: tail')).toEqual([]);
    expect(parser.end()).toEqual([{ data: 'tail' }]);
  });
});

describe('parseSseStream', () => {
  it('yields events from a ReadableStream split at arbitrary byte offsets', async () => {
    const wire = new TextEncoder().encode(formatSseEvent('first') + formatSseEvent('{"second":true}', { id: 2 }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire.slice(0, 5));
        controller.enqueue(wire.slice(5, 20));
        controller.enqueue(wire.slice(20));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events).toEqual([{ data: 'first' }, { id: '2', data: '{"second":true}' }]);
  });
});
