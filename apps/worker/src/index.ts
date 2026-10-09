import { Worker } from 'bullmq';
import { config, createRedis, pool, QUEUE_NAMES, type RenderJobData, type SendJobData } from '@vc/core';
import { processRender, processSend } from './jobs';
import { closeBrowser, getServeUrl } from './remotion';

console.log('bundling Remotion project...');
await getServeUrl();
console.log('bundle ready');

const renderWorker = new Worker<RenderJobData>(QUEUE_NAMES.render, processRender, {
  connection: createRedis(),
  concurrency: config.RENDER_CONCURRENCY,
  // Renders can take a while; keep the lock alive well past a single long job
  lockDuration: 5 * 60_000,
});

const sendWorker = new Worker<SendJobData>(QUEUE_NAMES.send, processSend, {
  connection: createRedis(),
  concurrency: 5,
  limiter: { max: config.WHATSAPP_SEND_RATE_PER_SEC, duration: 1000 },
});

for (const worker of [renderWorker, sendWorker]) {
  worker.on('completed', (job) => console.log(`[${worker.name}] done ${job.id}`));
  worker.on('failed', (job, err) => console.error(`[${worker.name}] failed ${job?.id}: ${err.message}`));
}

console.log(`worker running (render concurrency ${config.RENDER_CONCURRENCY})`);

async function shutdown() {
  console.log('shutting down...');
  await Promise.all([renderWorker.close(), sendWorker.close()]);
  await closeBrowser();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
