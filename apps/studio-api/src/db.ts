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

/** Creates a Prisma client backed by the `pg` driver adapter. */
export function createPrisma(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
