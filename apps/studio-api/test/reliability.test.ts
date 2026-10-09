import { connect } from 'node:net';
import { ApiErrorSchema, DirectorRunDTOSchema, ProjectDetailDTOSchema } from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { createPrisma } from '../src/db';
import { createDirectorFactory } from '../src/director/factory';
import { handleFailedJob, reapStaleRuns } from '../src/director/reaper';
import { retryTransient } from '../src/lib/retry';
import { startDirectorRun } from '../src/services/director-runs';
import { silentLogger } from '../src/lib/logger';
import { BullmqDirectorQueue, DEFAULT_JOB_LOCK_MS, startDirectorWorker } from '../src/queue/bullmq';
import { InlineDirectorQueue } from '../src/queue/inline';
import { QueueUnavailableError, type DirectorQueue, type QueueJobState } from '../src/queue/types';
import {
  buildTestApp,
  createUser,
  deferred,
  disconnectTestPrisma,
  insertProject,
  json,
  PricedMockProvider,
  sampleRequest,
  TEST_DATABASE_URL,
  testConfig,
  testPrisma,
  tokens,
  truncateAll,
  waitFor,
  type BuildTestAppOptions,
  type TestApp,
  type TestUser,
} from './helpers';

const prisma = testPrisma();
let t: TestApp | null = null;
let alice: TestUser;

async function setup(options: BuildTestAppOptions = {}): Promise<TestApp> {
  if (t !== null) await t.close();
  t = await buildTestApp(options);
  return t;
}

beforeEach(async () => {
  await truncateAll(prisma);
  alice = await createUser(prisma, 'alice@example.com');
});
afterEach(async () => {
  if (t !== null) await t.close();
  t = null;
});
afterAll(async () => {
  await disconnectTestPrisma();
});

async function createProject(app: TestApp, user: TestUser = alice): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: '/v1/projects', headers: user.auth, payload: sampleRequest() });
  expect(res.statusCode, res.body).toBe(201);
  return ProjectDetailDTOSchema.parse(json(res)).id;
}

async function startRun(app: TestApp, projectId: string): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: `/v1/projects/${projectId}/director-runs`, headers: alice.auth });
  expect(res.statusCode, res.body).toBe(202);
  return DirectorRunDTOSchema.parse(json(res)).id;
}

const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

async function redisReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(6379, '127.0.0.1');
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}
const REDIS_UP = await redisReachable();

describe('database pool (explicit size + connection timeout)', () => {
  it('a query waiting for a pooled connection fails after DATABASE_CONNECTION_TIMEOUT_MS instead of hanging', async () => {
    const small = createPrisma(TEST_DATABASE_URL, { max: 1, connectionTimeoutMs: 200 });
    try {
      const holding = small.$transaction(async (tx) => tx.$executeRaw`SELECT pg_sleep(1.5)`, { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 100));
      const started = Date.now();
      await expect(small.$queryRaw`SELECT 1`).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_200);
      await holding;
      expect(await small.$queryRaw`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
    } finally {
      await small.$disconnect();
    }
  });
});

describe('queue unavailable at start (Redis down)', () => {
  it('enqueue fails fast; the run is FAILED QUEUE_UNAVAILABLE, the project restored, the quota untouched', async () => {
    const config = testConfig({ QUEUE_DRIVER: 'bullmq', REDIS_URL: UNREACHABLE_REDIS, LIMIT_DIRECTOR_RUNS_PER_DAY: '1' });
    const queue = new BullmqDirectorQueue(UNREACHABLE_REDIS, { timeoutMs: 300 });
    const app = await buildApp({ config, prisma, queue, directorFactory: createDirectorFactory(config), logger: false });
    try {
      let started = Date.now();
      await expect(queue.enqueue({ runId: 'x' })).rejects.toBeInstanceOf(QueueUnavailableError);
      expect(Date.now() - started).toBeLessThan(2_000);

      const res = await app.inject({ method: 'POST', url: '/v1/projects', headers: alice.auth, payload: sampleRequest() });
      const projectId = ProjectDetailDTOSchema.parse(json(res)).id;
      started = Date.now();
      const run = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/director-runs`, headers: alice.auth });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(run.statusCode).toBe(503);
      expect(ApiErrorSchema.parse(json(run)).error.code).toBe('QUEUE_UNAVAILABLE');
      const row = await prisma.directorRun.findFirstOrThrow({ where: { projectId } });
      expect(row.status).toBe('FAILED');
      expect(row.errorCode).toBe('QUEUE_UNAVAILABLE');
      expect(row.startedAt).toBeNull();
      expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('DRAFT');
      // The failed start does not consume the runs/day quota: the retry is refused for the queue, not the quota.
      const again = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/director-runs`, headers: alice.auth });
      expect(again.statusCode).toBe(503);
      // Readiness reports the queue (no details).
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(503);
      expect(json(ready)).toEqual({ ok: false, checks: { database: 'ok', queue: 'error' } });
      await expect(queue.jobState('x')).rejects.toBeInstanceOf(QueueUnavailableError);
    } finally {
      await app.close();
      await queue.close();
    }
  });
});

describe('readiness', () => {
  it('/ready checks the database (and the queue with BullMQ); /health stays a liveness probe', async () => {
    const app = await setup();
    expect(json(await app.app.inject({ method: 'GET', url: '/ready' }))).toEqual({
      ok: true,
      checks: { database: 'ok', queue: 'skipped' },
    });
    const config = testConfig();
    const deadDb = createPrisma('postgres://postgres:postgres@127.0.0.1:1/video_studio_test', { connectionTimeoutMs: 200 });
    const queue = new InlineDirectorQueue(async () => undefined);
    const down = await buildApp({ config, prisma: deadDb, queue, directorFactory: createDirectorFactory(config), logger: false });
    try {
      const res = await down.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(json(res)).toEqual({ ok: false, checks: { database: 'error', queue: 'skipped' } });
      expect((await down.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await down.close();
      await queue.close();
      await deadDb.$disconnect();
    }
  });

  it.skipIf(!REDIS_UP)('reports a reachable Redis as ok (BullMQ driver)', async () => {
    const config = testConfig({ QUEUE_DRIVER: 'bullmq', REDIS_URL: 'redis://127.0.0.1:6379/15' });
    const queue = new BullmqDirectorQueue(config.redisUrl, { timeoutMs: 2_000 });
    const app = await buildApp({ config, prisma, queue, directorFactory: createDirectorFactory(config), logger: false });
    try {
      expect(json(await app.inject({ method: 'GET', url: '/ready' }))).toEqual({
        ok: true,
        checks: { database: 'ok', queue: 'ok' },
      });
      expect(await queue.jobState('no-such-run')).toBe('missing');
    } finally {
      await app.close();
      await queue.close();
    }
  });
});

describe('final writes survive a transient database error', () => {
  const installFault = async (failures: number) => {
    await prisma.$executeRawUnsafe('CREATE SEQUENCE IF NOT EXISTS test_fault_seq');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE test_fault_seq RESTART WITH 1');
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fault_project_versions() RETURNS trigger AS $$
      BEGIN
        IF nextval('test_fault_seq') <= ${failures} THEN RAISE EXCEPTION 'simulated database blip'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_fault BEFORE INSERT ON project_versions FOR EACH ROW EXECUTE FUNCTION test_fault_project_versions()',
    );
  };
  const removeFault = async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fault ON project_versions');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fault_project_versions()');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS test_fault_seq');
  };

  it('the success transaction is retried with backoff and the version is saved', async () => {
    await installFault(2);
    try {
      const app = await setup({ finalWriteRetryDelaysMs: [20, 20, 20] });
      const runId = await startRun(app, await createProject(app));
      await app.queue.onIdle();
      const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: runId }, include: { version: true } });
      expect(row.status).toBe('SUCCEEDED');
      expect(row.version?.version).toBe(1);
    } finally {
      await removeFault();
    }
  });

  it('when the result cannot be saved, the run is FAILED (never left RUNNING)', async () => {
    await installFault(100);
    try {
      const app = await setup({ finalWriteRetryDelaysMs: [10, 10] });
      const projectId = await createProject(app);
      const runId = await startRun(app, projectId);
      await app.queue.onIdle();
      const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } });
      expect(row.status).toBe('FAILED');
      expect(row.errorCode).toBe('INTERNAL');
      expect(row.inputTokens).toBeGreaterThan(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('FAILED');
    } finally {
      await removeFault();
    }
  });

  it('retryTransient retries with the given delays and rethrows non-retryable errors at once', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          if (calls < 3) throw new Error('blip');
          return 'ok';
        },
        { delaysMs: [1, 1, 1] },
      ),
    ).resolves.toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw new TypeError('fatal');
        },
        { delaysMs: [1, 1], isRetryable: (err) => !(err instanceof TypeError) },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });
});

class FakeQueue implements DirectorQueue {
  readonly driver = 'bullmq' as const;
  constructor(private readonly states: Record<string, QueueJobState | Error>) {}
  async enqueue(): Promise<void> {}
  async jobState(runId: string): Promise<QueueJobState> {
    const state = this.states[runId] ?? 'missing';
    if (state instanceof Error) throw state;
    return state;
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('stale-run reaper', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  async function insertRun(data: {
    status: 'RUNNING' | 'QUEUED';
    heartbeatAt?: Date | null;
    startedAt?: Date | null;
    createdAt?: Date;
  }): Promise<{ runId: string; projectId: string }> {
    const projectId = await insertProject(prisma, alice.id);
    await prisma.project.update({ where: { id: projectId }, data: { status: 'DIRECTING' } });
    const run = await prisma.directorRun.create({
      data: {
        projectId,
        requestedById: alice.id,
        status: data.status,
        provider: 'mock',
        model: 'mock-director-v1',
        promptVersion: 'test',
        progress: {},
        inputTokens: 777,
        estimatedCostUsd: '0.777000',
        heartbeatAt: data.heartbeatAt ?? null,
        startedAt: data.startedAt ?? null,
        ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
      },
    });
    return { runId: run.id, projectId };
  }

  it('fails RUNNING runs with a stale heartbeat (WORKER_LOST) and lost QUEUED runs (QUEUE_LOST), once', async () => {
    const config = testConfig();
    const stale = await insertRun({ status: 'RUNNING', heartbeatAt: minutesAgo(5), startedAt: minutesAgo(30) });
    const neverBeat = await insertRun({ status: 'RUNNING', heartbeatAt: null, startedAt: minutesAgo(5) });
    const fresh = await insertRun({ status: 'RUNNING', heartbeatAt: new Date(), startedAt: minutesAgo(30) });
    const lost = await insertRun({ status: 'QUEUED', createdAt: minutesAgo(30) });
    const failedJob = await insertRun({ status: 'QUEUED', createdAt: minutesAgo(30) });
    const waiting = await insertRun({ status: 'QUEUED', createdAt: minutesAgo(30) });
    const unknown = await insertRun({ status: 'QUEUED', createdAt: minutesAgo(30) });
    const young = await insertRun({ status: 'QUEUED', createdAt: new Date() });
    const queue = new FakeQueue({
      [failedJob.runId]: 'failed',
      [waiting.runId]: 'waiting',
      [unknown.runId]: new Error('redis down'),
    });
    const deps = { prisma, queue, config, logger: silentLogger };
    // Two reapers at once (two workers): every run transitions exactly once.
    const [a, b] = await Promise.all([reapStaleRuns(deps), reapStaleRuns(deps)]);
    const workerLost = [...a.workerLost, ...b.workerLost].sort();
    const queueLost = [...a.queueLost, ...b.queueLost].sort();
    expect(workerLost).toEqual([stale.runId, neverBeat.runId].sort());
    expect(queueLost).toEqual([lost.runId, failedJob.runId].sort());

    const status = async (runId: string) => prisma.directorRun.findUniqueOrThrow({ where: { id: runId } });
    const reaped = await status(stale.runId);
    expect(reaped.status).toBe('FAILED');
    expect(reaped.errorCode).toBe('WORKER_LOST');
    expect(reaped.finishedAt).not.toBeNull();
    // Usage persisted with progress is kept.
    expect(reaped.inputTokens).toBe(777);
    expect(reaped.estimatedCostUsd.toNumber()).toBeCloseTo(0.777, 6);
    expect((await status(lost.runId)).errorCode).toBe('QUEUE_LOST');
    for (const alive of [fresh, waiting, unknown, young]) expect((await status(alive.runId)).errorCode).toBeNull();
    // Project statuses are restored (no version yet → FAILED); live projects stay DIRECTING.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: stale.projectId } })).status).toBe('FAILED');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: fresh.projectId } })).status).toBe('DIRECTING');
    // A second pass finds nothing.
    expect(await reapStaleRuns(deps)).toEqual({ workerLost: [], queueLost: [] });
  });

  it('a live run keeps its heartbeat fresh; once it stops, the reaper fails it and the late worker cannot revive it', async () => {
    const gate = deferred();
    let reached = false;
    const provider = new PricedMockProvider('mock-director-v1', tokens(5, 5), async (index) => {
      if (index === 1) {
        reached = true;
        await gate.promise;
      }
    });
    const app = await setup({ provider, cancelPollMs: 20, env: { DIRECTOR_CACHE: 'off' } });
    const runId = await startRun(app, await createProject(app));
    await waitFor(async () => reached);
    const beat1 = (await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } })).heartbeatAt;
    await waitFor(async () => {
      const beat = (await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } })).heartbeatAt;
      return beat !== null && beat1 !== null && beat > beat1;
    });
    const deps = { prisma, queue: app.queue, config: app.config, logger: silentLogger };
    expect((await reapStaleRuns(deps)).workerLost).toEqual([]);
    // Pretend 5 minutes passed without a heartbeat (the worker died).
    const later = { ...deps, now: () => new Date(Date.now() + 5 * 60_000) };
    expect((await reapStaleRuns(later)).workerLost).toEqual([runId]);
    gate.resolve();
    await app.queue.onIdle();
    const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('WORKER_LOST');
    expect(await prisma.projectVersion.count()).toBe(0);
  });

  it('the inline queue reports only its own pending jobs', async () => {
    const gate = deferred();
    const queue = new InlineDirectorQueue(async () => gate.promise);
    await queue.enqueue({ runId: 'r1' });
    expect(['waiting', 'active']).toContain(await queue.jobState('r1'));
    expect(await queue.jobState('other')).toBe('missing');
    gate.resolve();
    await queue.onIdle();
    expect(await queue.jobState('r1')).toBe('missing');
  });
});

describe('failed BullMQ jobs (stalled lock, e.g. a long Redis outage)', () => {
  it('do not fail runs that are still being processed', async () => {
    const config = testConfig();
    const projectId = await insertProject(prisma, alice.id);
    const make = (heartbeatAt: Date | null, status: 'RUNNING' | 'QUEUED' = 'RUNNING') =>
      prisma.directorRun.create({
        data: {
          projectId,
          requestedById: alice.id,
          status,
          provider: 'mock',
          model: 'mock-director-v1',
          promptVersion: 'test',
          progress: {},
          heartbeatAt,
          startedAt: status === 'RUNNING' ? new Date() : null,
        },
      });
    const local = await make(new Date(0));
    const fresh = await make(new Date());
    const stale = await make(new Date(Date.now() - 10 * 60_000));
    const queued = await make(null, 'QUEUED');
    const deps = {
      prisma,
      config,
      logger: silentLogger,
      isActiveLocally: (runId: string) => runId === local.id,
      retryDelaysMs: [1],
    };
    expect(await handleFailedJob(deps, local.id)).toBe('skipped-active');
    expect(await handleFailedJob(deps, fresh.id)).toBe('skipped-fresh-heartbeat');
    expect(await handleFailedJob(deps, stale.id)).toBe('marked-failed');
    expect(await handleFailedJob(deps, queued.id)).toBe('marked-failed');
    const rows = await prisma.directorRun.findMany({ select: { id: true, status: true } });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(local.id)).toBe('RUNNING');
    expect(byId.get(fresh.id)).toBe('RUNNING');
    expect(byId.get(stale.id)).toBe('FAILED');
    expect(byId.get(queued.id)).toBe('FAILED');
  });

  it.skipIf(!REDIS_UP)('the worker holds job locks for DIRECTOR_JOB_LOCK_MS (default 5 min)', async () => {
    expect(DEFAULT_JOB_LOCK_MS).toBe(300_000);
    expect(testConfig().queue.jobLockMs).toBe(300_000);
    const handle = startDirectorWorker({
      redisUrl: 'redis://127.0.0.1:6379/15',
      concurrency: 1,
      lockDurationMs: 123_000,
      processor: async () => undefined,
      logger: silentLogger,
    });
    try {
      expect(handle.worker.opts.lockDuration).toBe(123_000);
      expect(handle.worker.opts.maxStalledCount).toBe(0);
    } finally {
      await handle.close();
    }
  });
});

describe('shutdown', () => {
  it('aborting the shutdown signal stops an in-flight run: FAILED SHUTDOWN with partial usage', async () => {
    const gate = deferred();
    let reached = false;
    const shutdown = new AbortController();
    const provider = new PricedMockProvider('claude-opus-5-5', tokens(1000, 1000), async (index) => {
      if (index === 1) {
        reached = true;
        await gate.promise;
      }
    });
    const app = await setup({ provider, shutdownSignal: shutdown.signal, env: { DIRECTOR_CACHE: 'off' } });
    const projectId = await createProject(app);
    const runId = await startRun(app, projectId);
    await waitFor(async () => reached);
    shutdown.abort();
    gate.resolve();
    await app.queue.onIdle();
    const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('SHUTDOWN');
    expect(row.inputTokens).toBe(1000);
    expect(row.estimatedCostUsd.toNumber()).toBeCloseTo(0.024, 6);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('FAILED');
    expect(provider.calls).toHaveLength(2);
  });

  it('a job delivered while shutting down is not started', async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const provider = new PricedMockProvider('mock-director-v1', tokens(1, 1));
    const app = await setup({ provider, shutdownSignal: shutdown.signal });
    const projectId = await createProject(app);
    const runId = await startRun(app, projectId);
    await app.queue.onIdle();
    const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('SHUTDOWN');
    expect(row.startedAt).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('FAILED');
  });
});

describe('progress persistence', () => {
  it('a stage change is written at once, even within the throttle window', async () => {
    const gate = deferred();
    let reached = false;
    const provider = new PricedMockProvider('mock-director-v1', tokens(1, 1), async (index) => {
      if (index === 3) {
        reached = true;
        await gate.promise;
      }
    });
    // A huge throttle: before, only the first progress event of the run would have been written.
    const app = await setup({ provider, progressThrottleMs: 60_000, env: { DIRECTOR_CACHE: 'off' } });
    const runId = await startRun(app, await createProject(app));
    await waitFor(async () => reached);
    const run = await app.app.inject({ method: 'GET', url: `/v1/director-runs/${runId}`, headers: alice.auth });
    const progress = z
      .object({ completedSteps: z.number(), currentStage: z.string().nullable() })
      .parse(DirectorRunDTOSchema.parse(json(run)).progress);
    // Calls: brief(0), outline(1), script(2), storyboard(3) ← in flight.
    expect(progress).toEqual({ completedSteps: 3, currentStage: 'storyboard' });
    gate.resolve();
    await app.queue.onIdle();
  });
});

describe('run timeout above the timer maximum', () => {
  it('a scaled timeout beyond 2^31 - 1 ms is clamped instead of firing immediately', async () => {
    const app = await setup({ env: { DIRECTOR_STEP_TIMEOUT_MS: '2147483647' } });
    const runId = await startRun(app, await createProject(app));
    await app.queue.onIdle();
    const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.errorCode).toBeNull();
    expect(row.status).toBe('SUCCEEDED');
  });
});

describe('delete racing start', () => {
  it('concurrent DELETE project and POST director-runs never answer 500', async () => {
    const app = await setup();
    for (let i = 0; i < 8; i++) {
      const projectId = await createProject(app);
      const [del, run] = await Promise.all([
        app.app.inject({ method: 'DELETE', url: `/v1/projects/${projectId}`, headers: alice.auth }),
        app.app.inject({ method: 'POST', url: `/v1/projects/${projectId}/director-runs`, headers: alice.auth }),
      ]);
      const outcome = `${del.statusCode}/${run.statusCode}`;
      // Either the delete wins (404 for the start) or the start wins (409 for the delete).
      expect(['204/404', '409/202']).toContain(outcome);
      await app.queue.onIdle();
    }
  });

  it('starting a run on a project deleted after the request began → 404, not a foreign-key 500', async () => {
    const app = await setup();
    const projectId = await createProject(app);
    await prisma.project.delete({ where: { id: projectId } });
    const deps = { prisma, config: app.config, queue: app.queue, directorFactory: app.factory, logger: silentLogger };
    await expect(startDirectorRun(deps, alice.id, projectId)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    // Another user's project is equally invisible under the lock.
    const bob = await createUser(prisma, 'bob@example.com');
    const bobProject = await createProject(app, bob);
    await expect(startDirectorRun(deps, alice.id, bobProject)).rejects.toMatchObject({ statusCode: 404 });
    expect(await prisma.directorRun.count()).toBe(0);
  });
});
