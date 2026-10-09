import type { AppConfig } from './config';
import type { PrismaClient } from './db';
import type { DirectorFactory } from './director/factory';
import type { Logger } from './lib/logger';
import type { DirectorQueue } from './queue/types';

/** Everything route handlers need; built once by `buildApp`. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  queue: DirectorQueue;
  directorFactory: DirectorFactory;
  logger: Logger;
}
