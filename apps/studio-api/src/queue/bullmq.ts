import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  DIRECTOR_JOB_NAME,
  DIRECTOR_QUEUE_NAME,
  type DirectorJob,
  type DirectorJobProcessor,
  type DirectorQueue,
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

/** Producer used by the API process. */
export class BullmqDirectorQueue implements DirectorQueue {
  readonly driver = 'bullmq' as const;
  private readonly connection: Redis;
  private readonly queue: Queue<DirectorJob, void, string>;

  constructor(redisUrl: string) {
    // Producers fail fast instead of hanging forever when Redis is unreachable.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.queue = new Queue<DirectorJob, void, string>(DIRECTOR_QUEUE_NAME, { connection: this.connection });
  }

  async enqueue(job: DirectorJob): Promise<void> {
    // jobId = runId makes enqueueing idempotent per run.
    await this.queue.add(DIRECTOR_JOB_NAME, job, { ...DIRECTOR_JOB_OPTIONS, jobId: job.runId });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}

export interface StartWorkerOptions {
  redisUrl: string;
  concurrency: number;
  processor: DirectorJobProcessor;
  logger: QueueLogger;
  /** Called when BullMQ gives up on a job (stalled worker, unexpected processor rejection). */
  onJobFailed?: (job: DirectorJob, error: Error) => Promise<void>;
}

export interface DirectorWorkerHandle {
  worker: Worker<DirectorJob, void, string>;
  close(): Promise<void>;
}

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
      // A stalled job (crashed worker) is failed rather than re-run; onJobFailed marks the run FAILED.
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
