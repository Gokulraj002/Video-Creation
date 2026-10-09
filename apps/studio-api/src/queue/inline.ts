import type { DirectorJob, DirectorJobProcessor, DirectorQueue } from './types';

export interface InlineQueueOptions {
  /** Called when the processor rejects (process-run normally records failures itself). */
  onError?: (error: unknown, job: DirectorJob) => void;
}

/**
 * In-process queue: jobs run asynchronously (next macrotask) in the API process, one promise each.
 * Meant for tests and single-process development (`QUEUE_DRIVER=inline`). `onIdle()` resolves when
 * every enqueued job (including ones enqueued while waiting) has settled.
 */
export class InlineDirectorQueue implements DirectorQueue {
  readonly driver = 'inline' as const;
  private processor: DirectorJobProcessor | null;
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(
    processor: DirectorJobProcessor | null = null,
    private readonly options: InlineQueueOptions = {},
  ) {
    this.processor = processor;
  }

  /** Late-binds the processor (the processor usually needs objects created after the queue). */
  setProcessor(processor: DirectorJobProcessor): void {
    this.processor = processor;
  }

  async enqueue(job: DirectorJob): Promise<void> {
    if (this.closed) throw new Error('Inline director queue is closed');
    const processor = this.processor;
    if (processor === null) throw new Error('Inline director queue has no processor');
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => processor(job))
      .catch((error: unknown) => {
        this.options.onError?.(error, job);
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  /** Resolves once no job is pending. */
  async onIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.onIdle();
  }
}
