/** Payload of a director job: the run row holds everything else. */
export interface DirectorJob {
  runId: string;
}

export type DirectorJobProcessor = (job: DirectorJob) => Promise<void>;

/** What the queue knows about the job of a run (used by the stale-run reaper). */
export type QueueJobState = 'waiting' | 'active' | 'completed' | 'failed' | 'missing';

/** Producer side of the director queue (the API only enqueues; workers process). */
export interface DirectorQueue {
  readonly driver: 'bullmq' | 'inline';
  /** Rejects quickly (QueueUnavailableError) when the backend is unreachable instead of hanging. */
  enqueue(job: DirectorJob): Promise<void>;
  /** State of the job enqueued for `runId`; rejects when the backend cannot be asked. */
  jobState(runId: string): Promise<QueueJobState>;
  /** Resolves when the queue backend is reachable (readiness probe); rejects otherwise. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class QueueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueUnavailableError';
  }
}

export const DIRECTOR_QUEUE_NAME = 'studio-director';
export const DIRECTOR_JOB_NAME = 'direct';
