import { QueueUnavailableError, type DirectorJob, type DirectorJobProcessor, type DirectorQueue, type QueueJobState } from './types';

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
  /** runId → state of its job while it is pending in this process. */
  private readonly jobs = new Map<string, 'waiting' | 'active'>();
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
    if (this.closed) throw new QueueUnavailableError('Inline director queue is closed');
    const processor = this.processor;
    if (processor === null) throw new QueueUnavailableError('Inline director queue has no processor');
    this.jobs.set(job.runId, 'waiting');
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => {
        this.jobs.set(job.runId, 'active');
        return processor(job);
      })
      .catch((error: unknown) => {
        this.options.onError?.(error, job);
      })
      .finally(() => {
        this.pending.delete(task);
        this.jobs.delete(job.runId);
      });
    this.pending.add(task);
  }

  /** Only jobs of this process are known; anything else (e.g. lost in a restart) is `missing`. */
  async jobState(runId: string): Promise<QueueJobState> {
    return this.jobs.get(runId) ?? 'missing';
  }

  async ping(): Promise<void> {
    if (this.closed) throw new QueueUnavailableError('Inline director queue is closed');
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
