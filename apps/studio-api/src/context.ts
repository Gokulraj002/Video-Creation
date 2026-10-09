import type { AppConfig } from './config';
import type { PrismaClient } from './db';
import type { DirectorFactory } from './director/factory';
import type { Logger } from './lib/logger';
import type { SizeBoundedLru } from './lib/lru';
import type { DirectorQueue } from './queue/types';

/** Everything route handlers need; built once by `buildApp`. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  queue: DirectorQueue;
  directorFactory: DirectorFactory;
  logger: Logger;
  /** Serialized version DTOs (versions are immutable); null when VERSION_CACHE_MAX_BYTES=0. */
  versionCache: SizeBoundedLru | null;
}
