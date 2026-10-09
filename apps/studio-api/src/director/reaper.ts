import type { AppConfig } from '../config';
import { RunStatus, type Prisma, type PrismaClient } from '../db';
import type { Logger } from '../lib/logger';
import { retryTransient } from '../lib/retry';
import type { DirectorQueue, QueueJobState } from '../queue/types';
import { restoreProjectStatus } from '../services/project-status';
import { markRunFailed } from './process-run';

export interface ReaperDeps {
  prisma: PrismaClient;
  queue: DirectorQueue;
  config: Pick<AppConfig, 'director'>;
  logger: Logger;
  /** Clock (tests). */
  now?: () => Date;
}

export interface ReapResult {
  /** RUNNING runs whose worker stopped heart-beating → FAILED (WORKER_LOST). */
  workerLost: string[];
  /** Old QUEUED runs whose queue job is gone/failed → FAILED (QUEUE_LOST). */
  queueLost: string[];
}

const BATCH = 100;

const WORKER_LOST_MESSAGE =
  'The director worker stopped responding while processing this run; start it again (completed stages are cached)';
const QUEUE_LOST_MESSAGE = 'The director queue lost this run before it started; start it again';

/** RUNNING with a heartbeat (or, before the first heartbeat, a start) older than the cutoff. */
function staleRunningWhere(cutoff: Date): Prisma.DirectorRunWhereInput {
  return {
    status: RunStatus.RUNNING,
    OR: [
      { heartbeatAt: { lt: cutoff } },
      { heartbeatAt: null, startedAt: { lt: cutoff } },
      { heartbeatAt: null, startedAt: null },
    ],
  };
}

/** Conditional transition + project restore in one transaction; false when another reaper/worker won. */
async function failIf(
  prisma: PrismaClient,
  where: Prisma.DirectorRunWhereInput,
  code: string,
  message: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.directorRun.findFirst({ where, select: { id: true, projectId: true } });
    if (row === null) return false;
    const res = await tx.directorRun.updateMany({
      where: { ...where, id: row.id },
      // Token/cost columns are left alone: they hold the usage persisted with progress.
      data: { status: RunStatus.FAILED, errorCode: code, errorMessage: message, finishedAt: new Date() },
    });
    if (res.count === 0) return false;
    if (row.projectId !== null) await restoreProjectStatus(tx, row.projectId, 'failed');
    return true;
  });
}

/**
 * One reaper pass. Safe with any number of concurrent reapers/workers: every transition is a conditional
 * update on the stale condition, so a run that heart-beats (or was reaped by someone else) is left alone.
 * - RUNNING runs with a heartbeat older than DIRECTOR_HEARTBEAT_STALE_MS → FAILED WORKER_LOST (usage kept).
 * - QUEUED runs older than DIRECTOR_QUEUED_STALE_MS whose job is missing/failed/completed in the queue →
 *   FAILED QUEUE_LOST (never re-enqueued: a duplicate delivery could process the request twice). Runs whose
 *   job state cannot be read (queue down) are left for a later pass.
 */
export async function reapStaleRuns(deps: ReaperDeps): Promise<ReapResult> {
  const { prisma, queue, config, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const result: ReapResult = { workerLost: [], queueLost: [] };

  const heartbeatCutoff = new Date(now.getTime() - config.director.heartbeatStaleMs);
  const stale = await prisma.directorRun.findMany({
    where: staleRunningWhere(heartbeatCutoff),
    select: { id: true },
    orderBy: { startedAt: 'asc' },
    take: BATCH,
  });
  for (const { id } of stale) {
    if (await failIf(prisma, { ...staleRunningWhere(heartbeatCutoff), id }, 'WORKER_LOST', WORKER_LOST_MESSAGE)) {
      result.workerLost.push(id);
    }
  }

  const queuedCutoff = new Date(now.getTime() - config.director.queuedStaleMs);
  const queued = await prisma.directorRun.findMany({
    where: { status: RunStatus.QUEUED, createdAt: { lt: queuedCutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });
  for (const { id } of queued) {
    let state: QueueJobState;
    try {
      state = await queue.jobState(id);
    } catch (err) {
      logger.warn({ err, runId: id }, 'reaper: cannot read the queue job state; will retry');
      continue;
    }
    if (state === 'waiting' || state === 'active') continue;
    const where = { id, status: RunStatus.QUEUED, createdAt: { lt: queuedCutoff } };
    if (await failIf(prisma, where, 'QUEUE_LOST', QUEUE_LOST_MESSAGE)) result.queueLost.push(id);
  }

  if (result.workerLost.length > 0 || result.queueLost.length > 0) {
    logger.warn({ ...result }, 'reaped stale director runs');
  }
  return result;
}

export interface ReaperHandle {
  /** Runs one pass now (also used by tests); resolves when it finished. */
  runOnce(): Promise<ReapResult | null>;
  stop(): Promise<void>;
}

/** Runs `reapStaleRuns` every `intervalMs` (no overlapping passes; errors are logged). */
export function startReaper(deps: ReaperDeps, intervalMs: number): ReaperHandle {
  let current: Promise<ReapResult | null> | null = null;
  const runOnce = (): Promise<ReapResult | null> => {
    if (current !== null) return current;
    current = reapStaleRuns(deps)
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'reaper pass failed');
        return null;
      })
      .finally(() => {
        current = null;
      });
    return current;
  };
  const timer = intervalMs > 0 ? setInterval(() => void runOnce(), intervalMs) : null;
  timer?.unref();
  return {
    runOnce,
    async stop() {
      if (timer !== null) clearInterval(timer);
      if (current !== null) await current;
    },
  };
}

export interface FailedJobDeps {
  prisma: PrismaClient;
  config: Pick<AppConfig, 'director'>;
  logger: Logger;
  /** True while this process is still processing the run. */
  isActiveLocally: (runId: string) => boolean;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
}

export type FailedJobOutcome = 'skipped-active' | 'skipped-fresh-heartbeat' | 'marked-failed';

/**
 * BullMQ gave up on a job (stalled lock — e.g. a Redis outage longer than the lock — or a processor
 * rejection). The run is failed only when nobody is processing it: not in this process, and no fresh
 * heartbeat from another worker. The write is retried through short database outages.
 */
export async function handleFailedJob(deps: FailedJobDeps, runId: string): Promise<FailedJobOutcome> {
  if (deps.isActiveLocally(runId)) return 'skipped-active';
  const retryOptions = {
    ...(deps.retryDelaysMs !== undefined ? { delaysMs: deps.retryDelaysMs } : {}),
    logger: deps.logger,
    logBindings: { runId },
  };
  const row = await retryTransient(
    () => deps.prisma.directorRun.findUnique({ where: { id: runId }, select: { status: true, heartbeatAt: true } }),
    { ...retryOptions, label: 'reading the failed job run' },
  );
  const now = (deps.now?.() ?? new Date()).getTime();
  if (
    row !== null &&
    row.status === RunStatus.RUNNING &&
    row.heartbeatAt !== null &&
    now - row.heartbeatAt.getTime() < deps.config.director.heartbeatStaleMs
  ) {
    return 'skipped-fresh-heartbeat';
  }
  await retryTransient(
    () =>
      markRunFailed(deps.prisma, runId, 'INTERNAL', 'The director worker stopped unexpectedly while processing this run'),
    { ...retryOptions, label: 'recording the failed job' },
  );
  return 'marked-failed';
}
