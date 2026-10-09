import type { Logger } from './logger';

/** Backoff schedule for writes that must not be lost to a transient DB error (~1 min in total). */
export const FINAL_WRITE_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export interface RetryOptions {
  /** Delay before each retry; the number of entries is the number of retries (default FINAL_WRITE_RETRY_DELAYS_MS). */
  delaysMs?: readonly number[];
  /** Errors for which this returns false are rethrown immediately (default: retry everything). */
  isRetryable?: (err: unknown) => boolean;
  logger?: Logger;
  /** Included in the retry log lines. */
  label?: string;
  logBindings?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying failures with the given backoff. Meant for idempotent / conditional DB writes (the
 * final state of a director run) where a short database outage must not strand the row.
 */
export async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? FINAL_WRITE_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined || (options.isRetryable !== undefined && !options.isRetryable(err))) throw err;
      options.logger?.warn(
        { ...options.logBindings, err, attempt: attempt + 1, retryInMs: delay },
        `${options.label ?? 'database write'} failed; retrying`,
      );
      await sleep(delay);
    }
  }
}
