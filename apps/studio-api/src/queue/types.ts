/** Payload of a director job: the run row holds everything else. */
export interface DirectorJob {
  runId: string;
}

export type DirectorJobProcessor = (job: DirectorJob) => Promise<void>;

/** Producer side of the director queue (the API only enqueues; workers process). */
export interface DirectorQueue {
  readonly driver: 'bullmq' | 'inline';
  enqueue(job: DirectorJob): Promise<void>;
  close(): Promise<void>;
}

export const DIRECTOR_QUEUE_NAME = 'studio-director';
export const DIRECTOR_JOB_NAME = 'direct';
