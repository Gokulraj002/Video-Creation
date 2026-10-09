import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export { Prisma, PrismaClient } from './generated/prisma/client';
export type {
  ApiToken,
  DirectorCacheEntry,
  DirectorRun,
  Project,
  ProjectVersion,
  User,
} from './generated/prisma/client';
export { ProjectStatus, RunStatus } from './generated/prisma/enums';

export interface PoolOptions {
  /** Maximum pooled connections (default 10, like `pg`). */
  max?: number;
  /** A query waiting longer than this for a free connection fails instead of waiting forever (default 5000). */
  connectionTimeoutMs?: number;
}

export const DEFAULT_POOL_OPTIONS = { max: 10, connectionTimeoutMs: 5_000 } as const;

/** Creates a Prisma client backed by the `pg` driver adapter with an explicitly sized pool. */
export function createPrisma(connectionString: string, pool: PoolOptions = {}): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: pool.max ?? DEFAULT_POOL_OPTIONS.max,
      connectionTimeoutMillis: pool.connectionTimeoutMs ?? DEFAULT_POOL_OPTIONS.connectionTimeoutMs,
    }),
  });
}
