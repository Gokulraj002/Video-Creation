import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config';
import type { RenderJobData, SendJobData } from './types';

export const QUEUE_NAMES = { render: 'render', send: 'send' } as const;

// BullMQ workers require maxRetriesPerRequest: null
export function createRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

let renderQueue: Queue<RenderJobData> | undefined;
let sendQueue: Queue<SendJobData> | undefined;

export function getRenderQueue(): Queue<RenderJobData> {
  renderQueue ??= new Queue<RenderJobData>(QUEUE_NAMES.render, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return renderQueue;
}

export function getSendQueue(): Queue<SendJobData> {
  sendQueue ??= new Queue<SendJobData>(QUEUE_NAMES.send, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return sendQueue;
}
