import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  DIRECTOR_JOB_NAME,
  DIRECTOR_QUEUE_NAME,
  QueueUnavailableError,
  type DirectorJob,
  type DirectorJobProcessor,
  type DirectorQueue,
  type QueueJobState,
} from './types';

const DirectorJobSchema = z.object({ runId: z.string().min(1).max(128) });

/** Job options for every director job (one attempt: the run row records failures). */
export const DIRECTOR_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: 1000,
  removeOnFail: 5000,
} as const;

export interface QueueLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Rejects with `onTimeout()` when `promise` does not settle within `ms` (the promise itself keeps running). */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface BullmqDirectorQueueOptions {
  /** Budget of one enqueue / job lookup / ping before it fails as unavailable (default 3000 ms). */
  timeoutMs?: number;
  logger?: QueueLogger;
}

/** ioredis statuses in which the connection is known to be down (a command would only wait or fail). */
const DOWN_STATUSES: ReadonlySet<string> = new Set(['reconnecting', 'close', 'end']);

/** Producer used by the API process (and by the worker's reaper to inspect jobs). */
export class BullmqDirectorQueue implements DirectorQueue {
  readonly driver = 'bullmq' as const;
  private readonly connection: Redis;
  private readonly queue: Queue<DirectorJob, void, string>;
  private readonly timeoutMs: number;
  private lastErrorLogAt = 0;

  constructor(redisUrl: string, options: BullmqDirectorQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    // Fail fast instead of hanging while Redis is unreachable: no offline queue (commands are rejected while
    // disconnected), one retry per command, a bounded connect, plus the enqueue timeout below (BullMQ waits
    // for the first "ready" event forever when Redis is down at startup).
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: Math.max(1_000, this.timeoutMs),
    });
    this.queue = new Queue<DirectorJob, void, string>(DIRECTOR_QUEUE_NAME, { connection: this.connection });
    // Without a listener, a connection error event would be an unhandled 'error' emit.
    this.queue.on('error', (err: Error) => {
      const now = Date.now();
      if (now - this.lastErrorLogAt < 10_000) return;
      this.lastErrorLogAt = now;
      options.logger?.warn({ err }, 'director queue (Redis) error');
    });
  }

  private assertConnectable(): void {
    const status = this.connection.status;
    if (DOWN_STATUSES.has(status)) throw new QueueUnavailableError(`Redis connection is ${status}`);
  }

  private timedOut(what: string): () => Error {
    return () => new QueueUnavailableError(`Timed out after ${this.timeoutMs} ms ${what} (Redis unavailable?)`);
  }

  async enqueue(job: DirectorJob): Promise<void> {
    this.assertConnectable();
    // jobId = runId makes enqueueing idempotent per run.
    const add = this.queue.add(DIRECTOR_JOB_NAME, job, { ...DIRECTOR_JOB_OPTIONS, jobId: job.runId });
    // A timed-out add may still complete once Redis is back; the worker then skips the (FAILED) run.
    add.catch(() => undefined);
    await withTimeout(add, this.timeoutMs, this.timedOut('enqueueing the director job'));
  }

  async jobState(runId: string): Promise<QueueJobState> {
    this.assertConnectable();
    const lookup = this.queue.getJobState(runId);
    lookup.catch(() => undefined);
    const state = await withTimeout(lookup, this.timeoutMs, this.timedOut('reading the director job state'));
    switch (state) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'active':
        return 'active';
      case 'unknown':
        return 'missing';
      default:
        // waiting, delayed, prioritized, waiting-children
        return 'waiting';
    }
  }

  async ping(): Promise<void> {
    this.assertConnectable();
    // Wait for BullMQ's connection to be ready (bounded below), then round-trip a PING.
    const pong = this.queue.client.then(() => this.connection.ping());
    pong.catch(() => undefined);
    await withTimeout(pong, this.timeoutMs, this.timedOut('pinging Redis'));
  }

  async close(): Promise<void> {
    if (this.connection.status === 'ready') {
      await withTimeout(this.queue.close(), this.timeoutMs, this.timedOut('closing the queue')).catch(() => undefined);
      this.connection.disconnect();
      return;
    }
    // Never connected / down: end the connection first so BullMQ stops waiting for "ready".
    this.connection.disconnect();
    await withTimeout(this.queue.close(), this.timeoutMs, this.timedOut('closing the queue')).catch(() => undefined);
  }
}

export interface StartWorkerOptions {
  redisUrl: string;
  concurrency: number;
  processor: DirectorJobProcessor;
  logger: QueueLogger;
  /**
   * BullMQ lock duration (ms): a worker that cannot renew its job lock for this long (e.g. Redis unreachable)
   * has its job counted as stalled. Default 5 minutes (BullMQ's own default is 30 s).
   */
  lockDurationMs?: number;
  /** Called when BullMQ gives up on a job (stalled worker, unexpected processor rejection). */
  onJobFailed?: (job: DirectorJob, error: Error) => Promise<void>;
}

export interface DirectorWorkerHandle {
  worker: Worker<DirectorJob, void, string>;
  close(): Promise<void>;
}

export const DEFAULT_JOB_LOCK_MS = 300_000;

/** Starts the BullMQ consumer for `studio-director` jobs. */
export function startDirectorWorker(options: StartWorkerOptions): DirectorWorkerHandle {
  // Workers use blocking commands: BullMQ requires maxRetriesPerRequest: null.
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<DirectorJob, void, string>(
    DIRECTOR_QUEUE_NAME,
    async (job: Job<DirectorJob, void, string>) => {
      const data = DirectorJobSchema.parse(job.data);
      await options.processor(data);
    },
    {
      connection,
      concurrency: options.concurrency,
      lockDuration: options.lockDurationMs ?? DEFAULT_JOB_LOCK_MS,
      // A stalled job (crashed worker) is failed rather than re-run; onJobFailed marks the run FAILED unless
      // its heartbeat shows it is still being processed (see handleFailedJob).
      maxStalledCount: 0,
    },
  );

  worker.on('failed', (job, error) => {
    options.logger.error({ err: error, jobId: job?.id }, 'director job failed');
    if (job === undefined || options.onJobFailed === undefined) return;
    const parsed = DirectorJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    options.onJobFailed(parsed.data, error).catch((err: unknown) => {
      options.logger.error({ err, jobId: job.id }, 'failed to record director job failure');
    });
  });
  worker.on('error', (error) => {
    options.logger.error({ err: error }, 'director worker error');
  });

  return {
    worker,
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}
