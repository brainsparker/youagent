/**
 * Server-Sent Events codec for A2A streaming (message/stream and
 * tasks/resubscribe). The A2A JSON-RPC binding streams one JSON-RPC
 * response object per SSE `data:` line; this module only deals with the
 * framing (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 */

/** Media type of an SSE response body. */
export const SSE_CONTENT_TYPE = 'text/event-stream';

/** One parsed SSE event. `data` is the joined payload, `id`/`event` are optional fields. */
export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Encode one SSE event. `data` is split on newlines so a multi-line payload
 * still arrives as a single event.
 */
export function formatSseEvent(data: string, fields: { id?: string | number; event?: string } = {}): string {
  let out = '';
  if (fields.id !== undefined) out += `id: ${fields.id}\n`;
  if (fields.event) out += `event: ${fields.event}\n`;
  for (const line of data.split(/\r\n|\r|\n/)) {
    out += `data: ${line}\n`;
  }
  return `${out}\n`;
}

/** Encode an SSE comment line, used as a keep-alive heartbeat. */
export function formatSseComment(text = ''): string {
  return `: ${text}\n\n`;
}

/**
 * Incremental SSE parser. Feed it chunks of text; it yields complete
 * events and keeps partial lines across chunk boundaries. Comment lines
 * (starting with `:`) are ignored, as the spec requires.
 */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private id: string | undefined;
  private event: string | undefined;

  /** Parse a chunk and return every event completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newline: number;
    // eslint-disable-next-line no-cond-assign
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, newline);
      const sepLength = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + sepLength);
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** Flush a trailing event that was never terminated by a blank line. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.consumeLine(this.buffer);
      this.buffer = '';
      if (event) events.push(event);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private consumeLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'event':
        this.event = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.data.length === 0) {
      this.event = undefined;
      return undefined;
    }
    const event: SseEvent = { data: this.data.join('\n') };
    if (this.id !== undefined) event.id = this.id;
    if (this.event) event.event = this.event;
    this.data = [];
    this.event = undefined;
    return event;
  }
}

/**
 * Read a `text/event-stream` body and yield parsed events until it ends.
 * Works with the WHATWG `ReadableStream` returned by `fetch`.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.end()) yield event;
  } finally {
    reader.releaseLock();
  }
}
