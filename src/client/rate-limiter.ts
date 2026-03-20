// ---------------------------------------------------------------------------
// Token-Bucket Rate Limiter with Request Queue
// ---------------------------------------------------------------------------

import type { RateLimiterConfig } from "./types.js";

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * A simple token-bucket rate limiter.
 *
 * - Tokens are replenished at a constant rate derived from `requestsPerMinute`.
 * - When a token is not immediately available the request is placed in a FIFO
 *   queue and resolved once a token becomes available.
 * - Provides a dedicated `backoff()` helper that the client calls after
 *   receiving a 429 response to pause all outgoing requests for an
 *   exponentially increasing delay.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private readonly queue: QueueEntry[] = [];
  private backoffUntil = 0;
  private consecutiveBackoffs = 0;

  constructor(config: RateLimiterConfig) {
    const rpm = Math.max(1, config.requestsPerMinute);
    this.maxTokens = rpm;
    this.tokens = rpm;
    // Refill one token every (60 000 / rpm) ms.
    this.refillIntervalMs = Math.floor(60_000 / rpm);
    this.startRefill();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Wait until a token is available.  Resolves immediately when the bucket
   * has capacity; otherwise the caller is enqueued.
   */
  async acquire(): Promise<void> {
    // If we are in a backoff window, wait it out first.
    const now = Date.now();
    if (this.backoffUntil > now) {
      await this.sleep(this.backoffUntil - now);
    }

    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }

    // No tokens available — queue the request.
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  /**
   * Signal that a 429 (rate-limited) response was received.  All pending and
   * future requests will be paused for an exponentially increasing delay.
   */
  backoff(): void {
    this.consecutiveBackoffs += 1;
    const delayMs = Math.min(
      1_000 * Math.pow(2, this.consecutiveBackoffs - 1),
      60_000,
    );
    this.backoffUntil = Date.now() + delayMs;
  }

  /** Reset the consecutive backoff counter (call after a successful request). */
  resetBackoff(): void {
    this.consecutiveBackoffs = 0;
  }

  /** Clean up the refill timer. Call when the client is no longer needed. */
  dispose(): void {
    if (this.refillTimer !== null) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    // Reject any pending queue entries.
    for (const entry of this.queue.splice(0)) {
      entry.reject(new Error("RateLimiter disposed"));
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private startRefill(): void {
    this.refillTimer = setInterval(() => {
      if (this.tokens < this.maxTokens) {
        this.tokens += 1;
      }
      this.drain();
    }, this.refillIntervalMs);

    // Allow the Node process to exit even if the timer is still running.
    if (typeof this.refillTimer === "object" && "unref" in this.refillTimer) {
      this.refillTimer.unref();
    }
  }

  /** Hand tokens to queued callers (FIFO). */
  private drain(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens -= 1;
      const entry = this.queue.shift()!;
      entry.resolve();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
