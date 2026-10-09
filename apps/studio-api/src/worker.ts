import { ConfigError, loadConfig } from './config';
import { createPrisma } from './db';
import { createDirectorFactory } from './director/factory';
import { markRunFailed, processDirectorRun } from './director/process-run';
import { createConsoleLogger } from './lib/logger';
import { startDirectorWorker } from './queue/bullmq';
import { DIRECTOR_QUEUE_NAME } from './queue/types';

/** BullMQ worker entrypoint: consumes `studio-director` jobs and runs the AI Director. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createConsoleLogger(config.logLevel, { service: 'studio-worker' });
  const prisma = createPrisma(config.databaseUrl);
  const directorFactory = createDirectorFactory(config);
  const deps = { prisma, config, directorFactory, logger };

  const handle = startDirectorWorker({
    redisUrl: config.redisUrl,
    concurrency: config.director.workerConcurrency,
    logger,
    processor: (job) => processDirectorRun(job.runId, deps),
    onJobFailed: async (job, error) => {
      await markRunFailed(prisma, job.runId, 'INTERNAL', `Director job failed in the worker: ${error.message}`.slice(0, 500));
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal received, exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down studio-worker (waiting for active runs; signal again to force)');
    try {
      await handle.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during worker shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await handle.worker.waitUntilReady();
  logger.info(
    {
      queue: DIRECTOR_QUEUE_NAME,
      concurrency: config.director.workerConcurrency,
      provider: directorFactory.providerInfo.name,
      model: directorFactory.providerInfo.model,
      cache: config.director.cacheEnabled,
    },
    'studio-worker ready',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`studio-worker failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exit(1);
});
