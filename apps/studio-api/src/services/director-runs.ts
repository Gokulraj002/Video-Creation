import { totalStepsFor } from '@vc/ai-director';
import type { DirectorRunDTO } from '@vc/schema';
import type { AppConfig } from '../config';
import { ProjectStatus, RunStatus, type Prisma, type PrismaClient } from '../db';
import type { DirectorFactory } from '../director/factory';
import { plannedStructure } from '../director/plan';
import { EMPTY_PROGRESS, runInclude, toDirectorRunDto } from '../lib/dto';
import { AppError, conflict, notFound } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { retryTransient } from '../lib/retry';
import type { DirectorQueue } from '../queue/types';
import { ACTIVE_RUN_STATUSES, restoreProjectStatus } from './project-status';
import { startOfUtcDay, usageWindowSince } from './usage';

export interface DirectorRunServiceDeps {
  prisma: PrismaClient;
  config: AppConfig;
  queue: DirectorQueue;
  directorFactory: DirectorFactory;
  logger: Logger;
}

/** Namespace (first key) of the transaction-scoped advisory lock that serializes one user's run starts. */
const USER_RUN_START_LOCK = 0x56430001;

const usd = (value: number): string => `$${value.toFixed(2)}`;
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Serializes run starts per user (across all of their projects) for the rest of the transaction, so the
 * quota checks below cannot be raced by concurrent requests.
 */
async function lockUserRunStarts(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_RUN_START_LOCK}::int4, hashtext(${userId}))`;
}

export interface RunCostEstimate {
  /** Cost ceiling of the run about to start (USD). */
  ceilingUsd: number;
  model: string;
  chapters: number;
}

/**
 * 429 QUOTA_EXCEEDED when the user has too many active runs, reached today's (UTC) run limit, or when today's
 * spend plus the reservations of their active runs plus this run's cost ceiling would exceed the USD limit.
 * Reads run on `tx` (the caller holds the per-user lock), never on a second pooled connection.
 */
async function assertQuota(
  tx: Prisma.TransactionClient,
  config: AppConfig,
  userId: string,
  estimate: RunCostEstimate,
  now: Date,
): Promise<void> {
  const since = startOfUtcDay(now);
  const today = await usageWindowSince(tx, userId, since);
  const active = await tx.directorRun.findMany({
    where: { requestedById: userId, status: { in: ACTIVE_RUN_STATUSES } },
    select: { createdAt: true, reservedCostUsd: true, estimatedCostUsd: true },
  });
  // An active run's reservation covers its own spend so far: only the not-yet-spent part is added.
  const reservedUsd = active
    .filter((r) => r.createdAt >= since)
    .reduce((sum, r) => sum + Math.max(0, r.reservedCostUsd.toNumber() - r.estimatedCostUsd.toNumber()), 0);
  const { directorRunsPerDay, directorUsdPerDay, activeRunsPerUser } = config.quotas;
  const committedUsd = today.estimatedCostUsd + reservedUsd;
  const details = {
    runsToday: today.runs,
    runsPerDayLimit: directorRunsPerDay,
    activeRuns: active.length,
    activeRunsLimit: activeRunsPerUser,
    estimatedCostTodayUsd: round6(today.estimatedCostUsd),
    reservedCostUsd: round6(reservedUsd),
    runCostCeilingUsd: round6(estimate.ceilingUsd),
    usdPerDayLimit: directorUsdPerDay,
  };
  if (active.length >= activeRunsPerUser) {
    throw new AppError(
      429,
      'QUOTA_EXCEEDED',
      `Too many active director runs (${active.length} queued or running; limit ${activeRunsPerUser} per user). ` +
        'Wait for one to finish or cancel it.',
      details,
    );
  }
  if (today.runs >= directorRunsPerDay) {
    throw new AppError(429, 'QUOTA_EXCEEDED', `Daily director run limit reached (${directorRunsPerDay} per UTC day)`, details);
  }
  if (committedUsd >= directorUsdPerDay) {
    throw new AppError(
      429,
      'QUOTA_EXCEEDED',
      `Daily AI spend limit reached (estimated ${usd(today.estimatedCostUsd)} spent + ${usd(reservedUsd)} reserved by ` +
        `active runs, of ${usd(directorUsdPerDay)} per UTC day)`,
      details,
    );
  }
  if (committedUsd + estimate.ceilingUsd > directorUsdPerDay) {
    throw new AppError(
      429,
      'QUOTA_EXCEEDED',
      `This director run could cost up to ${usd(estimate.ceilingUsd)} (estimated ceiling for ${estimate.chapters} ` +
        `chapter(s) on ${estimate.model}); with ${usd(today.estimatedCostUsd)} spent and ${usd(reservedUsd)} reserved ` +
        `today it would exceed the daily AI spend limit of ${usd(directorUsdPerDay)} per UTC day`,
      details,
    );
  }
}

const PROJECT_STATUSES: readonly ProjectStatus[] = Object.values(ProjectStatus);

function toProjectStatus(value: string): ProjectStatus {
  return PROJECT_STATUSES.find((s) => s === value) ?? ProjectStatus.DRAFT;
}

interface LockedProjectRow {
  id: string;
  status: string;
  request: unknown;
}

/**
 * The run could not be enqueued: QUEUED → FAILED (QUEUE_UNAVAILABLE) and the project goes back to the status
 * it had before the start. Returns false when the run is no longer QUEUED (the job did reach a worker).
 */
async function failUnqueuedRun(
  prisma: PrismaClient,
  runId: string,
  projectId: string,
  previousStatus: ProjectStatus,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const res = await tx.directorRun.updateMany({
      where: { id: runId, status: RunStatus.QUEUED },
      data: {
        status: RunStatus.FAILED,
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: 'The director queue was unavailable; the run was not started',
        finishedAt: new Date(),
      },
    });
    if (res.count === 0) return false;
    const otherActive = await tx.directorRun.count({ where: { projectId, status: { in: ACTIVE_RUN_STATUSES } } });
    if (otherActive > 0) return true;
    if (previousStatus === ProjectStatus.DIRECTING) {
      await restoreProjectStatus(tx, projectId, 'failed');
    } else {
      await tx.project.updateMany({
        where: { id: projectId, status: ProjectStatus.DIRECTING },
        data: { status: previousStatus },
      });
    }
    return true;
  });
}

/**
 * Creates a QUEUED run for the project (409 RUN_ACTIVE if one is queued/running), sets the project to
 * DIRECTING and enqueues `{runId}`. In one transaction: a per-user advisory lock (quotas cannot be raced
 * across projects), then the owner-scoped project row lock (404 when it is gone or not owned; concurrent
 * starts/deletes of the project serialize on it), then every check on that same transaction.
 * The run reserves its plan's cost ceiling against the daily USD quota while it is active.
 */
export async function startDirectorRun(
  deps: DirectorRunServiceDeps,
  userId: string,
  projectId: string,
): Promise<DirectorRunDTO> {
  const { prisma, directorFactory, config } = deps;
  const { run, previousStatus } = await prisma.$transaction(async (tx) => {
    await lockUserRunStarts(tx, userId);
    const locked = await tx.$queryRaw<LockedProjectRow[]>`
      SELECT id, status::text AS status, request FROM projects
       WHERE id = ${projectId} AND owner_id = ${userId}
         FOR UPDATE`;
    const project = locked[0];
    if (project === undefined) throw notFound('Project');
    const active = await tx.directorRun.findFirst({
      where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
      select: { id: true },
    });
    if (active !== null) {
      throw conflict('RUN_ACTIVE', 'A director run is already queued or running for this project', {
        runId: active.id,
      });
    }
    const plan = plannedStructure(project.request, config.limits);
    const totalSteps = plan === null ? 0 : totalStepsFor(plan);
    const ceilingUsd = plan === null ? 0 : directorFactory.estimateRunCostCeilingUsd(plan);
    await assertQuota(
      tx,
      config,
      userId,
      { ceilingUsd, model: directorFactory.providerInfo.model, chapters: plan?.chapterCount ?? 0 },
      new Date(),
    );
    const created = await tx.directorRun.create({
      data: {
        projectId,
        requestedById: userId,
        status: RunStatus.QUEUED,
        provider: directorFactory.providerInfo.name,
        model: directorFactory.providerInfo.model,
        promptVersion: directorFactory.promptVersion,
        progress: { ...EMPTY_PROGRESS, totalSteps, message: 'Queued' },
        reservedCostUsd: ceilingUsd.toFixed(6),
      },
      include: runInclude,
    });
    await tx.project.update({ where: { id: projectId }, data: { status: ProjectStatus.DIRECTING } });
    return { run: created, previousStatus: toProjectStatus(project.status) };
  });

  try {
    await deps.queue.enqueue({ runId: run.id });
  } catch (err) {
    deps.logger.error({ err, runId: run.id }, 'failed to enqueue director run');
    const failed = await retryTransient(() => failUnqueuedRun(prisma, run.id, projectId, previousStatus), {
      delaysMs: [100, 500, 1_000],
      logger: deps.logger,
      label: 'recording the enqueue failure',
      logBindings: { runId: run.id },
    });
    if (failed) {
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The director queue is unavailable; try again shortly');
    }
    // The job reached a worker after all: report the run as it is now.
    const current = await prisma.directorRun.findUniqueOrThrow({ where: { id: run.id }, include: runInclude });
    return toDirectorRunDto(current);
  }
  return toDirectorRunDto(run);
}

/** Latest 20 runs of an owned project, newest first. */
export async function listProjectRuns(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
): Promise<DirectorRunDTO[]> {
  const owned = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId }, select: { id: true } });
  if (owned === null) throw notFound('Project');
  const runs = await prisma.directorRun.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    include: runInclude,
  });
  return runs.map(toDirectorRunDto);
}

export async function getRun(prisma: PrismaClient, userId: string, runId: string): Promise<DirectorRunDTO> {
  const run = await prisma.directorRun.findFirst({
    where: { id: runId, project: { ownerId: userId } },
    include: runInclude,
  });
  if (run === null) throw notFound('Director run');
  return toDirectorRunDto(run);
}

/**
 * QUEUED/RUNNING → CANCELLED (409 RUN_NOT_ACTIVE otherwise). A running director notices the status
 * change on its next progress event / cancellation poll and aborts its in-flight provider call.
 */
export async function cancelRun(prisma: PrismaClient, userId: string, runId: string): Promise<DirectorRunDTO> {
  const run = await prisma.directorRun.findFirst({
    where: { id: runId, project: { ownerId: userId } },
    select: { id: true, projectId: true, status: true },
  });
  if (run === null || run.projectId === null) throw notFound('Director run');
  const projectIdOfRun = run.projectId;
  const notActive = () =>
    conflict('RUN_NOT_ACTIVE', `Director run is ${run.status.toLowerCase()} and can no longer be cancelled`);
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw notActive();

  return prisma.$transaction(async (tx) => {
    const res = await tx.directorRun.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN_STATUSES } },
      data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
    });
    if (res.count === 0) throw notActive();
    await restoreProjectStatus(tx, projectIdOfRun, 'cancelled');
    const updated = await tx.directorRun.findUniqueOrThrow({ where: { id: runId }, include: runInclude });
    return toDirectorRunDto(updated);
  });
}
