import {
  addUsage,
  DirectorError,
  estimateCostUsd,
  ZERO_USAGE,
  type DirectorProgress,
  type DirectorResult,
  type PricingTable,
} from '@vc/ai-director';
import { toWellFormedText, VideoRequestSchema, type DirectorRunProgress, type TokenUsage, type UsageReport } from '@vc/schema';
import { effectiveRunTimeoutMs, type AppConfig } from '../config';
import { Prisma, ProjectStatus, RunStatus, type PrismaClient } from '../db';
import { toJsonInput } from '../lib/json';
import type { Logger } from '../lib/logger';
import { retryTransient } from '../lib/retry';
import { restoreProjectStatus, type RunOutcome } from '../services/project-status';
import { spentTodayExcluding } from '../services/usage';
import type { DirectorFactory, ProviderCallUsage } from './factory';
import { plannedTotalSteps } from './plan';
import { PrismaDirectorCache } from './prisma-cache';

export interface ProcessRunDeps {
  prisma: PrismaClient;
  config: AppConfig;
  directorFactory: DirectorFactory;
  logger: Logger;
  /** Minimum interval between progress writes within one stage (default 500 ms); stage changes write at once. */
  progressThrottleMs?: number;
  /**
   * How often the run's heartbeat is written while it is RUNNING (default 2000 ms); the same write notices a
   * cancellation (the conditional update matches no row) and aborts the in-flight provider call.
   */
  cancelPollMs?: number;
  /**
   * Aborted when the process shuts down: in-flight runs stop promptly and are recorded FAILED with code
   * SHUTDOWN (partial usage kept, project status restored). They are deliberately NOT re-queued: a re-queue
   * during a crash/restart loop could run (and bill) the same request repeatedly, while FAILED is final and
   * the user can start the run again cheaply (validated stage outputs are cached).
   */
  shutdownSignal?: AbortSignal;
  /** Backoff for the final run writes (default ~1 min, see FINAL_WRITE_RETRY_DELAYS_MS). */
  finalWriteRetryDelaysMs?: readonly number[];
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

function tokenColumns(totals: TokenUsage, costUsd: number) {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    estimatedCostUsd: costUsd.toFixed(6),
  };
}

function usageColumns(usage: UsageReport) {
  return { usage: toJsonInput(usage), ...tokenColumns(usage.totals, usage.totals.estimatedCostUsd) };
}

function warningsJson(warnings: readonly string[] | undefined): string[] {
  // Slice by code points (never split a surrogate pair) and repair lone surrogates: Postgres jsonb rejects them.
  return (warnings ?? []).slice(0, 500).map((w) => toWellFormedText(Array.from(w).slice(0, 2000).join('')));
}

/** Running totals of the provider requests of one run (what it has spent so far, before the final report). */
export class LiveUsageMeter {
  private tokens: TokenUsage = { ...ZERO_USAGE };
  private cost = 0;
  private calls = 0;

  constructor(private readonly pricing: Readonly<PricingTable>) {}

  add(call: ProviderCallUsage): void {
    this.tokens = addUsage(this.tokens, call.usage);
    this.cost += estimateCostUsd(call.model, call.usage, this.pricing).costUsd;
    this.calls += 1;
  }

  get costUsd(): number {
    return this.cost;
  }

  get callCount(): number {
    return this.calls;
  }

  /** DirectorRun token/cost columns for the usage so far. */
  columns(): ReturnType<typeof tokenColumns> {
    return tokenColumns(this.tokens, this.cost);
  }
}

class RunNoLongerActiveError extends Error {
  constructor() {
    super('Director run is no longer RUNNING');
    this.name = 'RunNoLongerActiveError';
  }
}

type AbortReason = 'cancelled' | 'timeout' | 'quota' | 'shutdown';

const SHUTDOWN_MESSAGE =
  'The director worker shut down while processing this run; start it again (completed stages are cached)';

/**
 * Processes one director run (shared by the BullMQ worker and the inline queue):
 * claim QUEUED → RUNNING, run the AI Director with progress + usage persistence, a heartbeat, cancellation,
 * a timeout, a live daily-spend check and shutdown handling, then persist the new ProjectVersion atomically
 * (or record FAILED / CANCELLED). Usage consumed so far is written with progress (a crashed worker keeps
 * what it spent) and the final report is always persisted. Final writes are retried through short database
 * outages. Never throws for run-level failures; those are recorded on the run row.
 */
export async function processDirectorRun(runId: string, deps: ProcessRunDeps): Promise<void> {
  const { prisma, config, logger } = deps;
  const log = (level: 'info' | 'warn' | 'error', obj: object, msg: string) => logger[level]({ runId, ...obj }, msg);
  const retry = <T>(label: string, fn: () => Promise<T>, isRetryable?: (err: unknown) => boolean): Promise<T> =>
    retryTransient(fn, {
      ...(deps.finalWriteRetryDelaysMs !== undefined ? { delaysMs: deps.finalWriteRetryDelaysMs } : {}),
      ...(isRetryable !== undefined ? { isRetryable } : {}),
      logger,
      label,
      logBindings: { runId },
    });

  const run = await prisma.directorRun.findUnique({
    where: { id: runId },
    select: { status: true, requestedById: true, projectId: true, project: { select: { request: true } } },
  });
  if (run === null || run.status !== RunStatus.QUEUED || run.projectId === null || run.project === null) {
    log('info', {}, 'director run skipped (not queued)');
    return;
  }
  if (deps.shutdownSignal?.aborted === true) {
    await retry('recording the shutdown', () => markRunFailed(prisma, runId, 'SHUTDOWN', SHUTDOWN_MESSAGE));
    log('warn', {}, 'director run not started: shutting down');
    return;
  }
  const projectId = run.projectId;
  const userId = run.requestedById;
  const totalSteps = plannedTotalSteps(run.project.request, config.limits);
  const timeoutMs = effectiveRunTimeoutMs(config, totalSteps);

  const claimedAt = new Date();
  const claimed = await prisma.directorRun.updateMany({
    where: { id: runId, status: RunStatus.QUEUED },
    data: {
      status: RunStatus.RUNNING,
      startedAt: claimedAt,
      heartbeatAt: claimedAt,
      progress: { completedSteps: 0, totalSteps, currentStage: null, message: 'Starting AI Director' },
    },
  });
  if (claimed.count === 0) {
    log('info', {}, 'director run skipped (claimed or cancelled concurrently)');
    return;
  }

  const controller = new AbortController();
  // Mutated from callbacks, so kept in an object (no stale control-flow narrowing).
  const state: {
    abortReason: AbortReason | null;
    lastProgress: DirectorProgress | null;
    /** The director has returned: progress writes stop, the heartbeat keeps the row alive during final writes. */
    finished: boolean;
    quota: { othersUsd: number; runUsd: number } | null;
  } = { abortReason: null, lastProgress: null, finished: false, quota: null };
  const abort = (reason: AbortReason): void => {
    if (state.abortReason !== null || state.finished) return;
    state.abortReason = reason;
    const messages: Record<AbortReason, string> = {
      cancelled: 'Director run cancelled',
      timeout: 'Director run timed out',
      quota: 'Daily AI spend limit reached',
      shutdown: 'Director worker shutting down',
    };
    controller.abort(new Error(messages[reason]));
  };
  const onShutdown = () => abort('shutdown');
  deps.shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

  const meter = new LiveUsageMeter(deps.directorFactory.pricing);

  const timeout = setTimeout(() => abort('timeout'), timeoutMs);
  timeout.unref();

  // Heartbeat + cancellation poll. The conditional update matching no row means the run left RUNNING.
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = true;
    prisma.directorRun
      .updateMany({ where: { id: runId, status: RunStatus.RUNNING }, data: { heartbeatAt: new Date() } })
      .then((res) => {
        if (res.count === 0) abort('cancelled');
      })
      .catch((err: unknown) => log('warn', { err }, 'heartbeat write failed'))
      .finally(() => {
        beating = false;
      });
  }, deps.cancelPollMs ?? 2000);
  heartbeat.unref();

  // Progress (+ usage so far) writes: immediately on a stage change, otherwise throttled with a trailing flush.
  // Writes are chained so they reach the database in order; each writes the latest progress.
  const throttleMs = deps.progressThrottleMs ?? 500;
  let lastWriteAt = 0;
  let lastWrittenKey: string | null = null;
  let trailing: NodeJS.Timeout | null = null;
  let writes: Promise<void> = Promise.resolve();
  const writeProgress = (): Promise<void> => {
    if (trailing !== null) {
      clearTimeout(trailing);
      trailing = null;
    }
    const next = writes.then(async () => {
      const p = state.lastProgress;
      if (p === null || state.finished || state.abortReason !== null) return;
      lastWriteAt = Date.now();
      lastWrittenKey = `${p.stage}\u0000${p.chunk ?? ''}`;
      const res = await prisma.directorRun.updateMany({
        where: { id: runId, status: RunStatus.RUNNING },
        data: { progress: toRunProgress(p), heartbeatAt: new Date(), ...meter.columns() },
      });
      if (res.count === 0) abort('cancelled');
    });
    writes = next.catch((err: unknown) => log('warn', { err }, 'progress write failed'));
    return next;
  };
  const scheduleTrailingWrite = (): void => {
    if (trailing !== null) return;
    trailing = setTimeout(
      () => {
        trailing = null;
        void writeProgress().catch(() => undefined);
      },
      Math.max(0, throttleMs - (Date.now() - lastWriteAt)),
    );
    trailing.unref();
  };

  const usdLimit = config.quotas.directorUsdPerDay;
  /** Today's spend of the user's other runs + this run's live spend reached the daily limit? */
  const spendLimitReached = async (): Promise<boolean> => {
    const runUsd = meter.costUsd;
    // Zero-cost runs (mock provider, cache hits) never trip the spend limit.
    if (runUsd <= 0) return false;
    const othersUsd = await spentTodayExcluding(prisma, userId, runId, new Date());
    state.quota = { othersUsd, runUsd };
    return othersUsd + runUsd >= usdLimit;
  };

  const onProgress = async (p: DirectorProgress): Promise<void> => {
    state.lastProgress = p;
    if (state.abortReason !== null || state.finished) return;
    // Every LLM stage is preceded by a progress event: stop before spending more once the limit is reached.
    // (Compile makes no provider calls, so a finished plan is never discarded for the quota.)
    if (p.stage !== 'compile' && (await spendLimitReached())) {
      abort('quota');
      return;
    }
    const key = `${p.stage}\u0000${p.chunk ?? ''}`;
    if (key !== lastWrittenKey || Date.now() - lastWriteAt >= throttleMs) {
      await writeProgress();
    } else {
      scheduleTrailingWrite();
    }
  };

  let result: DirectorResult | null = null;
  let failure: unknown = null;
  try {
    const request = VideoRequestSchema.parse(run.project.request);
    // Cache entries are scoped to the requesting user (no cross-tenant hits).
    const cache = config.director.cacheEnabled ? new PrismaDirectorCache(prisma, userId) : null;
    const director = deps.directorFactory.createDirector({
      cache,
      logger,
      logBindings: { runId },
      onProviderCall: (call) => meter.add(call),
    });
    result = await director.planProject({ request }, { signal: controller.signal, onProgress });
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(timeout);
    deps.shutdownSignal?.removeEventListener('abort', onShutdown);
  }
  state.finished = true;
  if (trailing !== null) clearTimeout(trailing);
  await writes;

  try {
    await finishRun();
  } finally {
    clearInterval(heartbeat);
  }

  async function finishRun(): Promise<void> {
    // A complete result is kept unless the user cancelled (a late timeout/quota/shutdown signal changes nothing).
    if (result !== null && state.abortReason !== 'cancelled') {
      const done = result;
      try {
        const steps = state.lastProgress?.totalSteps ?? totalSteps;
        await retry(
          'saving the director result',
          () =>
            persistSuccess(prisma, runId, projectId, done, {
              completedSteps: steps,
              totalSteps: steps,
              currentStage: 'compile',
              message: 'Timeline ready',
            }),
          (err) => !(err instanceof RunNoLongerActiveError),
        );
        log('info', { projectId, usage: done.usage.totals, warnings: done.warnings.length }, 'director run succeeded');
        return;
      } catch (err) {
        if (err instanceof RunNoLongerActiveError) {
          await retry('recording the cancellation', () =>
            finalizeStopped(prisma, runId, projectId, 'cancelled', done.usage, done.warnings),
          );
          log('info', { projectId }, 'director run cancelled before its result was saved');
          return;
        }
        log('error', { projectId, err }, 'could not save the director result');
        failure = err;
      }
    }

    // Tokens spent before a failure/cancellation still count (quota + usage reporting). Without a report
    // (non-director error) the usage columns written with progress are kept.
    const partialUsage = result?.usage ?? (failure instanceof DirectorError ? (failure.usage ?? null) : null);
    const warnings = result?.warnings ?? (failure instanceof DirectorError ? failure.warnings : undefined);

    if (state.abortReason === 'cancelled') {
      await retry('recording the cancellation', () =>
        finalizeStopped(prisma, runId, projectId, 'cancelled', partialUsage, warnings),
      );
      log('info', { projectId }, 'director run cancelled');
      return;
    }

    let code: string;
    let message: string;
    if (state.abortReason === 'timeout' && result === null) {
      code = 'TIMEOUT';
      message = `Director run exceeded its timeout of ${timeoutMs} ms`;
    } else if (state.abortReason === 'quota' && result === null) {
      code = 'QUOTA_EXCEEDED';
      const q = state.quota;
      message =
        q === null
          ? 'Director run stopped: the daily AI spend limit was reached'
          : `Director run stopped: today's AI spend reached the daily limit ($${(q.othersUsd + q.runUsd).toFixed(2)} ` +
            `of $${usdLimit.toFixed(2)} per UTC day, $${q.runUsd.toFixed(2)} by this run)`;
    } else if (state.abortReason === 'shutdown' && result === null) {
      code = 'SHUTDOWN';
      message = SHUTDOWN_MESSAGE;
    } else if (failure instanceof DirectorError && failure.code !== 'INTERNAL') {
      code = failure.code;
      message = sanitizeErrorMessage(failure.message);
    } else {
      // Internal errors may carry stack-ish details: log them, store a generic message.
      code = 'INTERNAL';
      message = 'Unexpected error while directing the video (see server logs)';
    }
    log(code === 'INTERNAL' ? 'error' : 'warn', { projectId, code, err: failure }, 'director run failed');
    await retry('recording the run failure', () => markRunFailed(prisma, runId, code, message, partialUsage, warnings));
  }
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
          warnings: warningsJson(result.warnings),
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
          sceneCount: result.timeline.scenes.length,
          durationInFrames: result.timeline.durationInFrames,
          fps: result.timeline.settings.fps,
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

/** Records FAILED (with any partial usage/warnings) on a still-active run and restores the project status. */
export async function markRunFailed(
  prisma: PrismaClient,
  runId: string,
  code: string,
  message: string,
  usage: UsageReport | null = null,
  warnings?: readonly string[],
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
        ...(warnings !== undefined ? { warnings: warningsJson(warnings) } : {}),
      },
    });
    if (res.count > 0 && row.projectId !== null) await restoreProjectStatus(tx, row.projectId, 'failed');
  });
}

/**
 * The run was cancelled by the user (the cancel endpoint already set CANCELLED): ensure finishedAt, record
 * the usage consumed so far, and restore the project status (idempotent).
 */
async function finalizeStopped(
  prisma: PrismaClient,
  runId: string,
  projectId: string,
  outcome: RunOutcome,
  usage: UsageReport | null = null,
  warnings?: readonly string[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.directorRun.updateMany({
      where: { id: runId, status: RunStatus.CANCELLED, finishedAt: null },
      data: { finishedAt: new Date() },
    });
    if (usage !== null) {
      await tx.directorRun.updateMany({
        where: { id: runId, status: RunStatus.CANCELLED, usage: { equals: Prisma.DbNull } },
        data: { ...usageColumns(usage), ...(warnings !== undefined ? { warnings: warningsJson(warnings) } : {}) },
      });
    }
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { status: true } });
    if (project?.status === ProjectStatus.DIRECTING) await restoreProjectStatus(tx, projectId, outcome);
  });
}
