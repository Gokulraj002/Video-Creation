import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../db';
import type { DirectorQueue } from '../queue/types';
import { STUDIO_API_VERSION } from '../version';

export type CheckStatus = 'ok' | 'error' | 'skipped';

export interface ReadinessReport {
  ok: boolean;
  checks: { database: CheckStatus; queue: CheckStatus };
}

export interface HealthRouteDeps {
  prisma: PrismaClient;
  queue: DirectorQueue;
  /** Per-check budget (default 2000 ms). */
  checkTimeoutMs?: number;
  /** Results are reused for this long so the public probe cannot hammer the database (default 1000 ms). */
  cacheMs?: number;
}

async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const running = check();
    running.catch(() => undefined);
    await Promise.race([running, timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /health`: cheap liveness probe (no I/O). `GET /ready`: readiness — the database answers and, with the
 * BullMQ driver, Redis answers; 503 otherwise. Both public, not rate limited, and never include error details.
 */
export async function healthRoutes(app: FastifyInstance, deps: HealthRouteDeps): Promise<void> {
  const timeoutMs = deps.checkTimeoutMs ?? 2_000;
  const cacheMs = deps.cacheMs ?? 1_000;
  let cached: { at: number; report: Promise<ReadinessReport> } | null = null;

  const readiness = async (): Promise<ReadinessReport> => {
    const [database, queue] = await Promise.all([
      probe(() => deps.prisma.$queryRaw`SELECT 1`, timeoutMs),
      deps.queue.driver === 'bullmq' ? probe(() => deps.queue.ping(), timeoutMs) : Promise.resolve<CheckStatus>('skipped'),
    ]);
    return { ok: database === 'ok' && queue !== 'error', checks: { database, queue } };
  };

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true as const, version: STUDIO_API_VERSION }));

  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply): Promise<ReadinessReport> => {
    const now = Date.now();
    if (cached === null || now - cached.at >= cacheMs) cached = { at: now, report: readiness() };
    const report = await cached.report;
    reply.status(report.ok ? 200 : 503);
    return report;
  });
}
