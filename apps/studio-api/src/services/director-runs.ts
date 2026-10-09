import type { DirectorRunDTO } from '@vc/schema';
import type { AppConfig } from '../config';
import { ProjectStatus, RunStatus, type PrismaClient } from '../db';
import type { DirectorFactory } from '../director/factory';
import { plannedTotalSteps } from '../director/plan';
import { markRunFailed } from '../director/process-run';
import { EMPTY_PROGRESS, runInclude, toDirectorRunDto } from '../lib/dto';
import { AppError, conflict, notFound } from '../lib/errors';
import type { Logger } from '../lib/logger';
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

/** 429 QUOTA_EXCEEDED when today's (UTC) runs or estimated spend reached the configured per-user limits. */
async function assertQuota(deps: DirectorRunServiceDeps, userId: string, now: Date): Promise<void> {
  const today = await usageWindowSince(deps.prisma, userId, startOfUtcDay(now));
  const { directorRunsPerDay, directorUsdPerDay } = deps.config.quotas;
  const details = {
    runsToday: today.runs,
    runsPerDayLimit: directorRunsPerDay,
    estimatedCostTodayUsd: today.estimatedCostUsd,
    usdPerDayLimit: directorUsdPerDay,
  };
  if (today.runs >= directorRunsPerDay) {
    throw new AppError(429, 'QUOTA_EXCEEDED', `Daily director run limit reached (${directorRunsPerDay} per UTC day)`, details);
  }
  if (today.estimatedCostUsd >= directorUsdPerDay) {
    throw new AppError(
      429,
      'QUOTA_EXCEEDED',
      `Daily AI spend limit reached (estimated $${today.estimatedCostUsd.toFixed(2)} of $${directorUsdPerDay.toFixed(2)} per UTC day)`,
      details,
    );
  }
}

/**
 * Creates a QUEUED run for the project (409 RUN_ACTIVE if one is queued/running), sets the project to
 * DIRECTING and enqueues `{runId}`. The project row is locked so concurrent requests cannot both start a run.
 */
export async function startDirectorRun(
  deps: DirectorRunServiceDeps,
  userId: string,
  projectId: string,
): Promise<DirectorRunDTO> {
  const { prisma, directorFactory } = deps;
  const owned = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true, request: true },
  });
  if (owned === null) throw notFound('Project');
  const totalSteps = plannedTotalSteps(owned.request, deps.config.limits);

  const run = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<{ id: string }[]>`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
    const active = await tx.directorRun.findFirst({
      where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
      select: { id: true },
    });
    if (active !== null) {
      throw conflict('RUN_ACTIVE', 'A director run is already queued or running for this project', {
        runId: active.id,
      });
    }
    await assertQuota(deps, userId, new Date());
    const created = await tx.directorRun.create({
      data: {
        projectId,
        requestedById: userId,
        status: RunStatus.QUEUED,
        provider: directorFactory.providerInfo.name,
        model: directorFactory.providerInfo.model,
        promptVersion: directorFactory.promptVersion,
        progress: { ...EMPTY_PROGRESS, totalSteps, message: 'Queued' },
      },
      include: runInclude,
    });
    await tx.project.update({ where: { id: projectId }, data: { status: ProjectStatus.DIRECTING } });
    return created;
  });

  try {
    await deps.queue.enqueue({ runId: run.id });
  } catch (err) {
    deps.logger.error({ err, runId: run.id }, 'failed to enqueue director run');
    await markRunFailed(prisma, run.id, 'QUEUE_UNAVAILABLE', 'The director queue is unavailable');
    throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The director queue is unavailable; try again shortly');
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
  if (run === null) throw notFound('Director run');
  const notActive = () =>
    conflict('RUN_NOT_ACTIVE', `Director run is ${run.status.toLowerCase()} and can no longer be cancelled`);
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw notActive();

  return prisma.$transaction(async (tx) => {
    const res = await tx.directorRun.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN_STATUSES } },
      data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
    });
    if (res.count === 0) throw notActive();
    await restoreProjectStatus(tx, run.projectId, 'cancelled');
    const updated = await tx.directorRun.findUniqueOrThrow({ where: { id: runId }, include: runInclude });
    return toDirectorRunDto(updated);
  });
}
