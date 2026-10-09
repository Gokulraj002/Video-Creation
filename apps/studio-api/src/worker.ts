import { ConfigError, loadConfig } from './config';
import { createPrisma } from './db';
import { createDirectorFactory } from './director/factory';
import { processDirectorRun, type ProcessRunDeps } from './director/process-run';
import { handleFailedJob, startReaper } from './director/reaper';
import { createConsoleLogger } from './lib/logger';
import { BullmqDirectorQueue, startDirectorWorker } from './queue/bullmq';
import { DIRECTOR_QUEUE_NAME } from './queue/types';

/** BullMQ worker entrypoint: consumes `studio-director` jobs, runs the AI Director and reaps stale runs. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createConsoleLogger(config.logLevel, { service: 'studio-worker' });
  const prisma = createPrisma(config.databaseUrl, {
    max: config.databasePool.max,
    connectionTimeoutMs: config.databasePool.connectionTimeoutMs,
  });
  const directorFactory = createDirectorFactory(config);
  // Aborted on SIGINT/SIGTERM: in-flight runs stop and are recorded FAILED (SHUTDOWN), see ProcessRunDeps.
  const shutdownController = new AbortController();
  const deps: ProcessRunDeps = { prisma, config, directorFactory, logger, shutdownSignal: shutdownController.signal };
  /** Runs this process is processing right now (a failed-job event for one of them is not a lost run). */
  const active = new Set<string>();
  // Producer-side connection used by the reaper to inspect jobs of old QUEUED runs.
  const inspector = new BullmqDirectorQueue(config.redisUrl, { timeoutMs: config.queue.enqueueTimeoutMs, logger });

  const handle = startDirectorWorker({
    redisUrl: config.redisUrl,
    concurrency: config.director.workerConcurrency,
    lockDurationMs: config.queue.jobLockMs,
    logger,
    processor: async (job) => {
      active.add(job.runId);
      try {
        await processDirectorRun(job.runId, deps);
      } finally {
        active.delete(job.runId);
      }
    },
    // Stalled job (crashed worker, long Redis outage) or an unexpected processor error: fail the run unless
    // it is still being processed (here, or by another worker with a fresh heartbeat). Details go to the log.
    onJobFailed: async (job) => {
      const outcome = await handleFailedJob(
        { prisma, config, logger, isActiveLocally: (runId) => active.has(runId) },
        job.runId,
      );
      if (outcome !== 'marked-failed') logger.warn({ runId: job.runId, outcome }, 'failed director job ignored: run is alive');
    },
  });
  const reaper = startReaper({ prisma, queue: inspector, config, logger }, config.director.reaperIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal received, exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal, activeRuns: active.size }, 'shutting down studio-worker (stopping active runs; signal again to force)');
    shutdownController.abort();
    try {
      await reaper.stop();
      await handle.close();
      await inspector.close();
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
      lockDurationMs: config.queue.jobLockMs,
      reaperIntervalMs: config.director.reaperIntervalMs,
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
