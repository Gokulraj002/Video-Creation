import { DirectorError, type DirectorProgress, type DirectorResult } from '@vc/ai-director';
import { VideoRequestSchema, type DirectorRunProgress, type UsageReport } from '@vc/schema';
import type { AppConfig } from '../config';
import { Prisma, ProjectStatus, RunStatus, type PrismaClient } from '../db';
import { toJsonInput } from '../lib/json';
import type { Logger } from '../lib/logger';
import { restoreProjectStatus, type RunOutcome } from '../services/project-status';
import type { DirectorFactory } from './factory';
import { PrismaDirectorCache } from './prisma-cache';

export interface ProcessRunDeps {
  prisma: PrismaClient;
  config: AppConfig;
  directorFactory: DirectorFactory;
  logger: Logger;
  /** Minimum interval between progress writes (default 500 ms). */
  progressThrottleMs?: number;
  /** How often the DB is polled for a cancellation while a provider call is in flight (default 2000 ms). */
  cancelPollMs?: number;
}

const MAX_ERROR_MESSAGE = 1000;

/** Strips control characters and anything that looks like a credential; caps the length. */
export function sanitizeErrorMessage(message: string): string {
  const cleaned = message
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_ERROR_MESSAGE ? `${cleaned.slice(0, MAX_ERROR_MESSAGE - 1)}…` : cleaned;
}

function toRunProgress(p: DirectorProgress): DirectorRunProgress {
  return {
    completedSteps: p.completedSteps,
    totalSteps: p.totalSteps,
    currentStage: p.stage,
    message: p.message,
  };
}

function usageColumns(usage: UsageReport) {
  return {
    usage: toJsonInput(usage),
    inputTokens: usage.totals.inputTokens,
    outputTokens: usage.totals.outputTokens,
    cacheReadTokens: usage.totals.cacheReadTokens,
    cacheWriteTokens: usage.totals.cacheWriteTokens,
    estimatedCostUsd: usage.totals.estimatedCostUsd.toFixed(6),
  };
}

class RunNoLongerActiveError extends Error {
  constructor() {
    super('Director run is no longer RUNNING');
    this.name = 'RunNoLongerActiveError';
  }
}

type AbortReason = 'cancelled' | 'timeout';

/**
 * Processes one director run (shared by the BullMQ worker and the inline queue):
 * claim QUEUED → RUNNING, run the AI Director with progress persistence + cancellation + timeout, then
 * persist the new ProjectVersion atomically (or record FAILED / CANCELLED). Never throws for run-level
 * failures; those are recorded on the run row.
 */
export async function processDirectorRun(runId: string, deps: ProcessRunDeps): Promise<void> {
  const { prisma, config, logger } = deps;
  const log = (level: 'info' | 'warn' | 'error', obj: object, msg: string) => logger[level]({ runId, ...obj }, msg);

  const startedAt = new Date();
  const claimed = await prisma.directorRun.updateMany({
    where: { id: runId, status: RunStatus.QUEUED },
    data: {
      status: RunStatus.RUNNING,
      startedAt,
      progress: { completedSteps: 0, totalSteps: 0, currentStage: null, message: 'Starting AI Director' },
    },
  });
  if (claimed.count === 0) {
    log('info', {}, 'director run skipped (not queued)');
    return;
  }

  const run = await prisma.directorRun.findUnique({
    where: { id: runId },
    select: { projectId: true, project: { select: { request: true } } },
  });
  if (run === null) return; // deleted in between (project deleted)
  const projectId = run.projectId;

  const controller = new AbortController();
  // Mutated from callbacks, so kept in an object (no stale control-flow narrowing).
  const state: { abortReason: AbortReason | null; lastProgress: DirectorProgress | null } = {
    abortReason: null,
    lastProgress: null,
  };
  const abort = (reason: AbortReason): void => {
    if (state.abortReason !== null) return;
    state.abortReason = reason;
    controller.abort(new Error(reason === 'timeout' ? 'Director run timed out' : 'Director run cancelled'));
  };

  const isStillRunning = async (): Promise<boolean> => {
    const row = await prisma.directorRun.findUnique({ where: { id: runId }, select: { status: true } });
    return row !== null && row.status === RunStatus.RUNNING;
  };

  const timeout = setTimeout(() => abort('timeout'), config.director.runTimeoutMs);
  timeout.unref();
  let polling = false;
  const poll = setInterval(() => {
    if (polling || state.abortReason !== null) return;
    polling = true;
    isStillRunning()
      .then((running) => {
        if (!running) abort('cancelled');
      })
      .catch((err: unknown) => log('warn', { err }, 'cancellation poll failed'))
      .finally(() => {
        polling = false;
      });
  }, deps.cancelPollMs ?? 2000);
  poll.unref();

  const throttleMs = deps.progressThrottleMs ?? 500;
  let lastWrite = 0;
  const onProgress = async (p: DirectorProgress): Promise<void> => {
    state.lastProgress = p;
    if (state.abortReason !== null) return;
    const now = Date.now();
    if (now - lastWrite >= throttleMs) {
      lastWrite = now;
      const res = await prisma.directorRun.updateMany({
        where: { id: runId, status: RunStatus.RUNNING },
        data: { progress: toRunProgress(p) },
      });
      if (res.count === 0) abort('cancelled');
    } else if (!(await isStillRunning())) {
      abort('cancelled');
    }
  };

  let result: DirectorResult | null = null;
  let failure: unknown = null;
  try {
    const request = VideoRequestSchema.parse(run.project.request);
    const cache = config.director.cacheEnabled ? new PrismaDirectorCache(prisma) : null;
    const director = deps.directorFactory.createDirector({ cache, logger });
    result = await director.planProject({ request }, { signal: controller.signal, onProgress });
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
  }

  if (result !== null && state.abortReason === null) {
    try {
      const totalSteps = state.lastProgress?.totalSteps ?? 0;
      await persistSuccess(prisma, runId, projectId, result, {
        completedSteps: totalSteps,
        totalSteps,
        currentStage: 'compile',
        message: 'Timeline ready',
      });
      log('info', { projectId, usage: result.usage.totals, warnings: result.warnings.length }, 'director run succeeded');
      return;
    } catch (err) {
      if (err instanceof RunNoLongerActiveError) {
        await finalizeStopped(prisma, runId, projectId, 'cancelled');
        log('info', { projectId }, 'director run cancelled before its result was saved');
        return;
      }
      failure = err;
    }
  }

  // Tokens spent before a failure/cancellation still count (quota + usage reporting).
  const partialUsage = failure instanceof DirectorError ? failure.usage : null;

  if (state.abortReason === 'cancelled') {
    await finalizeStopped(prisma, runId, projectId, 'cancelled', partialUsage);
    log('info', { projectId }, 'director run cancelled');
    return;
  }

  let code: string;
  let message: string;
  if (state.abortReason === 'timeout') {
    code = 'TIMEOUT';
    message = `Director run exceeded the configured timeout of ${config.director.runTimeoutMs} ms`;
  } else if (failure instanceof DirectorError && failure.code !== 'INTERNAL') {
    code = failure.code;
    message = sanitizeErrorMessage(failure.message);
  } else {
    // Internal errors may carry stack-ish details: log them, store a generic message.
    code = 'INTERNAL';
    message = 'Unexpected error while directing the video (see server logs)';
  }
  log(code === 'INTERNAL' ? 'error' : 'warn', { projectId, code, err: failure }, 'director run failed');
  await markRunFailed(prisma, runId, code, message, partialUsage);
}

async function persistSuccess(
  prisma: PrismaClient,
  runId: string,
  projectId: string,
  result: DirectorResult,
  progress: DirectorRunProgress,
): Promise<void> {
  const finishedAt = new Date();
  const timeline = toJsonInput(result.timeline);
  const artifacts = toJsonInput(result.artifacts);
  await prisma.$transaction(
    async (tx) => {
      const done = await tx.directorRun.updateMany({
        where: { id: runId, status: RunStatus.RUNNING },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt,
          ...usageColumns(result.usage),
          progress,
        },
      });
      if (done.count === 0) throw new RunNoLongerActiveError();
      const max = await tx.projectVersion.aggregate({ where: { projectId }, _max: { version: true } });
      const version = await tx.projectVersion.create({
        data: {
          projectId,
          version: (max._max.version ?? 0) + 1,
          schemaVersion: result.timeline.schemaVersion,
          timeline,
          artifacts,
          directorRunId: runId,
        },
        select: { id: true },
      });
      await tx.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.READY, currentVersionId: version.id },
      });
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/** Records FAILED on a still-active run and restores the project status. */
export async function markRunFailed(
  prisma: PrismaClient,
  runId: string,
  code: string,
  message: string,
  usage: UsageReport | null = null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.directorRun.findUnique({ where: { id: runId }, select: { projectId: true } });
    if (row === null) return;
    const res = await tx.directorRun.updateMany({
      where: { id: runId, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      data: {
        status: RunStatus.FAILED,
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
        ...(usage !== null ? usageColumns(usage) : {}),
      },
    });
    if (res.count > 0) await restoreProjectStatus(tx, row.projectId, 'failed');
  });
}

/** The run was stopped by the user: ensure finishedAt and restore the project status (idempotent). */
async function finalizeStopped(
  prisma: PrismaClient,
  runId: string,
  projectId: string,
  outcome: RunOutcome,
  usage: UsageReport | null = null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.directorRun.updateMany({
      where: { id: runId, status: RunStatus.CANCELLED, finishedAt: null },
      data: { finishedAt: new Date() },
    });
    if (usage !== null) {
      await tx.directorRun.updateMany({
        where: { id: runId, status: RunStatus.CANCELLED, usage: { equals: Prisma.DbNull } },
        data: usageColumns(usage),
      });
    }
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { status: true } });
    if (project?.status === ProjectStatus.DIRECTING) await restoreProjectStatus(tx, projectId, outcome);
  });
}
