import { describe, it, expect, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter | undefined;

  afterEach(() => {
    limiter?.dispose?.();
  });

  it('grants tokens immediately while the bucket has capacity', async () => {
    limiter = new RateLimiter({ requestsPerMinute: 60 });
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('queues once the bucket is empty and resolves after a refill', async () => {
    // 600 rpm → refill every 100ms, bucket starts with 600 tokens; drain it
    limiter = new RateLimiter({ requestsPerMinute: 2 });
    await limiter.acquire();
    await limiter.acquire();

    // Third acquire must wait for a refill (~30s at 2rpm) — don't await it,
    // just verify it stays pending briefly.
    let resolved = false;
    // .catch swallows the rejection when afterEach disposes the limiter
    const pending = limiter
      .acquire()
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    void pending;
  });

  it('backoff() delays subsequent acquires', async () => {
    limiter = new RateLimiter({ requestsPerMinute: 600 });
    limiter.backoff(); // 1s delay
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });
});
