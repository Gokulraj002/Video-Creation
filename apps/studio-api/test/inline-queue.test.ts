import { describe, expect, it } from 'vitest';
import { InlineDirectorQueue } from '../src/queue/inline';

describe('InlineDirectorQueue', () => {
  it('processes jobs asynchronously and onIdle waits for all of them', async () => {
    const seen: string[] = [];
    const queue = new InlineDirectorQueue(async (job) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(job.runId);
    });
    await queue.enqueue({ runId: 'a' });
    await queue.enqueue({ runId: 'b' });
    expect(seen).toEqual([]); // not processed synchronously
    await queue.onIdle();
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('waits for jobs enqueued while idling and reports processor errors', async () => {
    const errors: string[] = [];
    const seen: string[] = [];
    const queue = new InlineDirectorQueue(null, {
      onError: (err, job) => errors.push(`${job.runId}:${err instanceof Error ? err.message : String(err)}`),
    });
    queue.setProcessor(async (job) => {
      seen.push(job.runId);
      if (job.runId === 'first') await queue.enqueue({ runId: 'second' });
      if (job.runId === 'second') throw new Error('boom');
    });
    await queue.enqueue({ runId: 'first' });
    await queue.onIdle();
    expect(seen).toEqual(['first', 'second']);
    expect(errors).toEqual(['second:boom']);
  });

  it('rejects enqueues after close or without a processor', async () => {
    await expect(new InlineDirectorQueue().enqueue({ runId: 'x' })).rejects.toThrow(/no processor/);
    const queue = new InlineDirectorQueue(async () => undefined);
    await queue.close();
    await expect(queue.enqueue({ runId: 'x' })).rejects.toThrow(/closed/);
    expect(queue.driver).toBe('inline');
  });
});
