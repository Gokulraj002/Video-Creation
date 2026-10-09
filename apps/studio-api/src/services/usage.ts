import type { UsageSummaryDTO, UsageWindow } from '@vc/schema';
import { RunStatus, type Prisma } from '../db';

/** A Prisma client or interactive-transaction client (quota reads run on the caller's transaction). */
export type Db = Prisma.TransactionClient;

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Error codes of runs that failed before any work started (the queue never delivered them). */
export const NEVER_STARTED_ERROR_CODES: readonly string[] = ['QUEUE_UNAVAILABLE', 'QUEUE_LOST'];

/**
 * Runs that count toward usage and the runs/day quota: everything except runs that FAILED before they
 * started because the queue was unavailable or lost them (they consumed nothing and the user chose nothing).
 */
export const COUNTED_RUN_FILTER: Prisma.DirectorRunWhereInput = {
  OR: [
    { status: { not: RunStatus.FAILED } },
    { startedAt: { not: null } },
    { errorCode: null },
    { errorCode: { notIn: [...NEVER_STARTED_ERROR_CODES] } },
  ],
};

/** Aggregates the user's counted director runs created at or after `since` (all statuses). */
export async function usageWindowSince(db: Db, userId: string, since: Date): Promise<UsageWindow> {
  const agg = await db.directorRun.aggregate({
    where: { requestedById: userId, createdAt: { gte: since }, ...COUNTED_RUN_FILTER },
    _count: { _all: true },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      estimatedCostUsd: true,
    },
  });
  return {
    runs: agg._count._all,
    inputTokens: agg._sum.inputTokens ?? 0,
    outputTokens: agg._sum.outputTokens ?? 0,
    cacheReadTokens: agg._sum.cacheReadTokens ?? 0,
    cacheWriteTokens: agg._sum.cacheWriteTokens ?? 0,
    estimatedCostUsd: agg._sum.estimatedCostUsd?.toNumber() ?? 0,
  };
}

/** Estimated spend (USD) of the user's runs created today (UTC), excluding `runId` (live in-flight checks). */
export async function spentTodayExcluding(db: Db, userId: string, runId: string, now: Date): Promise<number> {
  const agg = await db.directorRun.aggregate({
    where: { requestedById: userId, createdAt: { gte: startOfUtcDay(now) }, id: { not: runId } },
    _sum: { estimatedCostUsd: true },
  });
  return agg._sum.estimatedCostUsd?.toNumber() ?? 0;
}

/** `GET /v1/usage`: today = current UTC day, month = current UTC calendar month. */
export async function usageSummary(db: Db, userId: string, now = new Date()): Promise<UsageSummaryDTO> {
  const [today, month] = await Promise.all([
    usageWindowSince(db, userId, startOfUtcDay(now)),
    usageWindowSince(db, userId, startOfUtcMonth(now)),
  ]);
  return { today, month };
}
