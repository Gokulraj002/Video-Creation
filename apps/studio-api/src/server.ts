import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createPrisma } from './db';
import { createDirectorFactory } from './director/factory';
import { processDirectorRun } from './director/process-run';
import { startReaper, type ReaperHandle } from './director/reaper';
import { BullmqDirectorQueue } from './queue/bullmq';
import { InlineDirectorQueue } from './queue/inline';
import type { DirectorQueue } from './queue/types';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = createPrisma(config.databaseUrl, {
    max: config.databasePool.max,
    connectionTimeoutMs: config.databasePool.connectionTimeoutMs,
  });
  const directorFactory = createDirectorFactory(config);
  const shutdownController = new AbortController();

  let inline: InlineDirectorQueue | null = null;
  let queue: DirectorQueue;
  if (config.queueDriver === 'bullmq') {
    queue = new BullmqDirectorQueue(config.redisUrl, { timeoutMs: config.queue.enqueueTimeoutMs });
  } else {
    inline = new InlineDirectorQueue();
    queue = inline;
  }

  const app = await buildApp({ config, prisma, queue, directorFactory });
  let reaper: ReaperHandle | null = null;
  if (inline !== null) {
    const deps = { prisma, config, directorFactory, logger: app.log, shutdownSignal: shutdownController.signal };
    inline.setProcessor((job) => processDirectorRun(job.runId, deps));
    // With the inline driver this process is the worker, so it also reaps stale runs.
    reaper = startReaper({ prisma, queue: inline, config, logger: app.log }, config.director.reaperIntervalMs);
    app.log.warn('QUEUE_DRIVER=inline: director runs execute inside the API process (development only)');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down studio-api');
    const force = setTimeout(() => process.exit(1), 90_000);
    force.unref();
    // Inline runs stop and are recorded FAILED (SHUTDOWN) instead of holding the shutdown for hours.
    shutdownController.abort();
    try {
      await reaper?.stop();
      await app.close();
      await queue.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { provider: directorFactory.providerInfo.name, model: directorFactory.providerInfo.model, queue: queue.driver },
    'studio-api ready',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`studio-api failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exit(1);
});
