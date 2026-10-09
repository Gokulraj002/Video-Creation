import type { AIProvider } from '@vc/ai-director';
import type { CreateProjectRequestInput } from '@vc/schema';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { createPrisma, type PrismaClient } from '../src/db';
import { createDirectorFactory, type DirectorFactory } from '../src/director/factory';
import { processDirectorRun } from '../src/director/process-run';
import { silentLogger } from '../src/lib/logger';
import { generateApiToken, hashToken } from '../src/lib/tokens';
import { InlineDirectorQueue } from '../src/queue/inline';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_studio_test';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    QUEUE_DRIVER: 'inline',
    AI_PROVIDER: 'mock',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

let sharedPrisma: PrismaClient | null = null;

/** One Prisma client per test file (vitest isolates modules per file). */
export function testPrisma(): PrismaClient {
  sharedPrisma ??= createPrisma(TEST_DATABASE_URL);
  return sharedPrisma;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (sharedPrisma !== null) {
    await sharedPrisma.$disconnect();
    sharedPrisma = null;
  }
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE director_cache_entries, project_versions, director_runs, projects, api_tokens, users RESTART IDENTITY CASCADE`;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  auth: { authorization: string };
}

export async function createUser(prisma: PrismaClient, email: string, name: string | null = null): Promise<TestUser> {
  const user = await prisma.user.create({ data: { email, name } });
  const token = generateApiToken();
  await prisma.apiToken.create({ data: { userId: user.id, label: 'test', tokenHash: hashToken(token) } });
  return { id: user.id, email, token, auth: { authorization: `Bearer ${token}` } };
}

export interface TestApp {
  app: FastifyInstance;
  config: AppConfig;
  prisma: PrismaClient;
  queue: InlineDirectorQueue;
  factory: DirectorFactory;
  close(): Promise<void>;
}

export interface BuildTestAppOptions {
  env?: Record<string, string>;
  provider?: AIProvider;
  progressThrottleMs?: number;
  cancelPollMs?: number;
}

/** Fastify app wired exactly like production, but with the inline queue and the given (mock) provider. */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const config = testConfig(options.env);
  const prisma = testPrisma();
  const factory = createDirectorFactory(config, options.provider !== undefined ? { provider: options.provider } : {});
  const queue = new InlineDirectorQueue();
  queue.setProcessor((job) =>
    processDirectorRun(job.runId, {
      prisma,
      config,
      directorFactory: factory,
      logger: silentLogger,
      ...(options.progressThrottleMs !== undefined ? { progressThrottleMs: options.progressThrottleMs } : {}),
      ...(options.cancelPollMs !== undefined ? { cancelPollMs: options.cancelPollMs } : {}),
    }),
  );
  const app = await buildApp({ config, prisma, queue, directorFactory: factory, logger: false });
  await app.ready();
  return {
    app,
    config,
    prisma,
    queue,
    factory,
    async close() {
      await queue.close();
      await app.close();
    },
  };
}

export function sampleRequest(overrides: Partial<CreateProjectRequestInput> = {}): CreateProjectRequestInput {
  return {
    title: 'Launch teaser',
    prompt: 'A 30 second promo for a solar-powered backpack that charges your phone on the go.',
    genre: 'promo',
    styleNotes: 'Bold, energetic, outdoorsy',
    durationSeconds: 30,
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    language: 'en',
    brand: { name: 'SunPack', colors: ['#FF7A00', '#1B1B1B'] },
    voiceOver: { enabled: true, style: 'upbeat', gender: 'female' },
    music: { enabled: true, mood: 'energetic' },
    ...overrides,
  };
}

export function json<T = unknown>(res: LightMyRequestResponse): T {
  return JSON.parse(res.body) as T;
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A promise you resolve from the outside (used to hold a scripted provider mid-run). */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
