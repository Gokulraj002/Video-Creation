import type { UsageSummaryDTO, UsageWindow } from '@vc/schema';
import type { PrismaClient } from '../db';

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Aggregates the user's director runs created at or after `since` (all statuses count). */
export async function usageWindowSince(prisma: PrismaClient, userId: string, since: Date): Promise<UsageWindow> {
  const agg = await prisma.directorRun.aggregate({
    where: { requestedById: userId, createdAt: { gte: since } },
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

/** `GET /v1/usage`: today = current UTC day, month = current UTC calendar month. */
export async function usageSummary(prisma: PrismaClient, userId: string, now = new Date()): Promise<UsageSummaryDTO> {
  const [today, month] = await Promise.all([
    usageWindowSince(prisma, userId, startOfUtcDay(now)),
    usageWindowSince(prisma, userId, startOfUtcMonth(now)),
  ]);
  return { today, month };
}
