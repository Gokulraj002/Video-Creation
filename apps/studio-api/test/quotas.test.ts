import { ApiErrorSchema, DirectorRunDTOSchema, ProjectDetailDTOSchema, UsageSummaryDTOSchema } from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { markRunFailed } from '../src/director/process-run';
import {
  buildTestApp,
  createUser,
  deferred,
  disconnectTestPrisma,
  json,
  PricedMockProvider,
  sampleRequest,
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
let bob: TestUser;

async function setup(options: BuildTestAppOptions = {}): Promise<TestApp> {
  if (t !== null) await t.close();
  t = await buildTestApp(options);
  return t;
}

beforeEach(async () => {
  await truncateAll(prisma);
  alice = await createUser(prisma, 'alice@example.com');
  bob = await createUser(prisma, 'bob@example.com');
});
afterEach(async () => {
  if (t !== null) await t.close();
  t = null;
});
afterAll(async () => {
  await disconnectTestPrisma();
});

async function createProject(app: TestApp, user: TestUser, title = 'p'): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: '/v1/projects', headers: user.auth, payload: sampleRequest({ title }) });
  expect(res.statusCode, res.body).toBe(201);
  return ProjectDetailDTOSchema.parse(json(res)).id;
}

const start = (app: TestApp, user: TestUser, projectId: string) =>
  app.app.inject({ method: 'POST', url: `/v1/projects/${projectId}/director-runs`, headers: user.auth, payload: {} });

const QuotaDetailsSchema = z.object({
  runsToday: z.number(),
  activeRuns: z.number(),
  estimatedCostTodayUsd: z.number(),
  reservedCostUsd: z.number(),
  runCostCeilingUsd: z.number(),
  usdPerDayLimit: z.number(),
});

/** Cost ceiling of the 30 s sample request (1 chapter) on claude-opus-5-5 (see cost-ceiling tests). */
const PROMO_CEILING_USD = 2.32;

describe('start-run transaction (pool + per-user lock)', () => {
  it('20 concurrent starts by one user on 20 projects neither deadlock the pool nor race the runs/day quota', async () => {
    const gate = deferred();
    const app = await setup({
      provider: new PricedMockProvider('mock-director-v1', tokens(10, 10), () => gate.promise),
      env: { LIMIT_DIRECTOR_RUNS_PER_DAY: '3', LIMIT_ACTIVE_RUNS_PER_USER: '100', DIRECTOR_CACHE: 'off' },
    });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await createProject(app, alice, `p${i}`));
    const started = Date.now();
    const results = await Promise.all(ids.map((id) => start(app, alice, id)));
    const elapsed = Date.now() - started;
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 202)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(17);
    for (const r of results.filter((x) => x.statusCode === 429)) {
      expect(ApiErrorSchema.parse(json(r)).error.code).toBe('QUOTA_EXCEEDED');
    }
    // Previously each start held a transaction connection while the quota read waited for a second one.
    expect(elapsed).toBeLessThan(10_000);
    expect(await prisma.directorRun.count({ where: { requestedById: alice.id } })).toBe(3);
    // Other users are served meanwhile.
    const other = await app.app.inject({ method: 'GET', url: '/v1/projects', headers: bob.auth });
    expect(other.statusCode).toBe(200);
    gate.resolve();
    await app.queue.onIdle();
  });
});

describe('USD/day quota: cost ceiling reservations', () => {
  it('refuses a run whose cost ceiling alone exceeds the limit, naming the estimate', async () => {
    const app = await setup({
      provider: new PricedMockProvider('claude-opus-5-5', tokens(1000, 1000)),
      env: { LIMIT_DIRECTOR_USD_PER_DAY: '1' },
    });
    expect(app.factory.estimateRunCostCeilingUsd({ chapterCount: 1 })).toBeCloseTo(PROMO_CEILING_USD, 6);
    const projectId = await createProject(app, alice);
    const res = await start(app, alice, projectId);
    expect(res.statusCode).toBe(429);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(body.error.message).toContain('$2.32');
    expect(body.error.message).toMatch(/exceed the daily AI spend limit of \$1\.00/);
    expect(QuotaDetailsSchema.parse(body.error.details).runCostCeilingUsd).toBeCloseTo(PROMO_CEILING_USD, 6);
    expect(await prisma.directorRun.count()).toBe(0);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('DRAFT');
  });

  it('counts reservations of active runs; finished runs only count what they spent', async () => {
    const gate = deferred();
    const app = await setup({
      provider: new PricedMockProvider('claude-opus-5-5', tokens(1000, 1000), () => gate.promise),
      env: { LIMIT_DIRECTOR_USD_PER_DAY: '5', LIMIT_ACTIVE_RUNS_PER_USER: '10', DIRECTOR_CACHE: 'off' },
    });
    const [p1, p2, p3] = [await createProject(app, alice, 'a'), await createProject(app, alice, 'b'), await createProject(app, alice, 'c')];
    if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error('projects');
    expect((await start(app, alice, p1)).statusCode).toBe(202);
    expect((await start(app, alice, p2)).statusCode).toBe(202);
    // 2 × $2.32 reserved + $2.32 > $5.
    const third = await start(app, alice, p3);
    expect(third.statusCode).toBe(429);
    const details = QuotaDetailsSchema.parse(ApiErrorSchema.parse(json(third)).error.details);
    expect(details.reservedCostUsd).toBeCloseTo(2 * PROMO_CEILING_USD, 6);
    const rows = await prisma.directorRun.findMany({ select: { reservedCostUsd: true } });
    expect(rows.map((r) => r.reservedCostUsd.toNumber())).toEqual([PROMO_CEILING_USD, PROMO_CEILING_USD]);
    // Quotas are per user.
    const bobProject = await createProject(app, bob);
    expect((await start(app, bob, bobProject)).statusCode).toBe(202);

    gate.resolve();
    await app.queue.onIdle();
    // 7 provider calls × (1000 × $4 + 1000 × $20) / 1M = $0.168 per run: the reservations are released.
    const usage = UsageSummaryDTOSchema.parse(json(await app.app.inject({ method: 'GET', url: '/v1/usage', headers: alice.auth })));
    expect(usage.today.estimatedCostUsd).toBeCloseTo(2 * 0.168, 6);
    expect((await start(app, alice, p3)).statusCode).toBe(202);
    await app.queue.onIdle();
  });

  it('concurrent starts on different projects cannot over-reserve', async () => {
    const gate = deferred();
    const app = await setup({
      provider: new PricedMockProvider('claude-opus-5-5', tokens(10, 10), () => gate.promise),
      env: { LIMIT_DIRECTOR_USD_PER_DAY: '5', LIMIT_ACTIVE_RUNS_PER_USER: '50', DIRECTOR_CACHE: 'off' },
    });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await createProject(app, alice, `p${i}`));
    const codes = (await Promise.all(ids.map((id) => start(app, alice, id)))).map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 202, 429, 429, 429, 429, 429, 429]);
    gate.resolve();
    await app.queue.onIdle();
  });

  it('aborts a running run with QUOTA_EXCEEDED once today’s spend + its live spend reach the limit', async () => {
    // $12 per call: 3M input tokens × $4/MTok.
    const provider = new PricedMockProvider('claude-opus-5-5', tokens(3_000_000));
    const app = await setup({ provider, env: { LIMIT_DIRECTOR_USD_PER_DAY: '30', DIRECTOR_CACHE: 'off' } });
    const earlier = await createProject(app, alice, 'earlier');
    await prisma.directorRun.create({
      data: {
        projectId: earlier,
        requestedById: alice.id,
        status: 'SUCCEEDED',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        promptVersion: 'test',
        progress: {},
        estimatedCostUsd: '20.000000',
        finishedAt: new Date(),
      },
    });
    const projectId = await createProject(app, alice);
    // $20 spent + $2.32 ceiling ≤ $30: the run starts…
    const res = await start(app, alice, projectId);
    expect(res.statusCode, res.body).toBe(202);
    const run = DirectorRunDTOSchema.parse(json(res));
    await app.queue.onIdle();
    // …but its first call costs $12 ($20 + $12 ≥ $30): it stops before the next stage.
    expect(provider.calls).toEqual(['brief']);
    const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('QUOTA_EXCEEDED');
    expect(row.errorMessage).toMatch(/daily limit/);
    // Partial usage is persisted.
    expect(row.inputTokens).toBe(3_000_000);
    expect(row.estimatedCostUsd.toNumber()).toBeCloseTo(12, 6);
    expect(row.usage).not.toBeNull();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('FAILED');
  });
});

describe('active runs per user', () => {
  it('LIMIT_ACTIVE_RUNS_PER_USER (default 2) caps queued + running runs across projects', async () => {
    const gate = deferred();
    const app = await setup({ provider: new PricedMockProvider('mock-director-v1', tokens(1, 1), () => gate.promise) });
    expect(app.config.quotas.activeRunsPerUser).toBe(2);
    const ids = [await createProject(app, alice, 'a'), await createProject(app, alice, 'b'), await createProject(app, alice, 'c')];
    const [a, b, c] = ids;
    if (a === undefined || b === undefined || c === undefined) throw new Error('projects');
    const first = DirectorRunDTOSchema.parse(json(await start(app, alice, a)));
    expect((await start(app, alice, b)).statusCode).toBe(202);
    const res = await start(app, alice, c);
    expect(res.statusCode).toBe(429);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(body.error.message).toMatch(/active director runs/);
    // Per user.
    expect((await start(app, bob, await createProject(app, bob))).statusCode).toBe(202);
    // Cancelling one frees a slot.
    const cancel = await app.app.inject({ method: 'POST', url: `/v1/director-runs/${first.id}/cancel`, headers: alice.auth });
    expect(cancel.statusCode).toBe(200);
    expect((await start(app, alice, c)).statusCode).toBe(202);
    gate.resolve();
    await app.queue.onIdle();
  });
});

describe('runs/day quota', () => {
  it('runs that never started (queue unavailable / lost) do not consume the daily run quota', async () => {
    const app = await setup({ env: { LIMIT_DIRECTOR_RUNS_PER_DAY: '1' } });
    const projectId = await createProject(app, alice);
    for (const errorCode of ['QUEUE_UNAVAILABLE', 'QUEUE_LOST']) {
      await prisma.directorRun.create({
        data: {
          projectId,
          requestedById: alice.id,
          status: 'FAILED',
          provider: 'mock',
          model: 'mock-director-v1',
          promptVersion: 'test',
          progress: {},
          errorCode,
          errorMessage: 'never started',
          finishedAt: new Date(),
        },
      });
    }
    expect((await start(app, alice, projectId)).statusCode).toBe(202);
    await app.queue.onIdle();
    const usage = UsageSummaryDTOSchema.parse(json(await app.app.inject({ method: 'GET', url: '/v1/usage', headers: alice.auth })));
    expect(usage.today.runs).toBe(1);
    // A run that failed while running still counts.
    const res = await start(app, alice, projectId);
    expect(res.statusCode).toBe(429);
  });
});

describe('usage persisted while running', () => {
  it('a crashed run keeps the tokens/cost written with its progress', async () => {
    const gate = deferred();
    let reached = false;
    const provider = new PricedMockProvider('claude-opus-5-5', tokens(1000, 1000), async (index) => {
      if (index === 2) {
        reached = true;
        await gate.promise;
      }
    });
    const app = await setup({ provider, progressThrottleMs: 0, env: { DIRECTOR_CACHE: 'off' } });
    const projectId = await createProject(app, alice);
    const run = DirectorRunDTOSchema.parse(json(await start(app, alice, projectId)));
    await waitFor(async () => reached);
    // While the third call is in flight, the first two calls are already on the row.
    const live = await prisma.directorRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(live.status).toBe('RUNNING');
    expect(live.inputTokens).toBe(2000);
    expect(live.outputTokens).toBe(2000);
    expect(live.estimatedCostUsd.toNumber()).toBeCloseTo(2 * 0.024, 6);
    // The worker "crashes": BullMQ's failed-job handler records the failure without a usage report.
    await markRunFailed(prisma, run.id, 'INTERNAL', 'The director worker stopped unexpectedly while processing this run');
    gate.resolve();
    await app.queue.onIdle();
    const after = await prisma.directorRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect(after.inputTokens).toBe(2000);
    expect(after.estimatedCostUsd.toNumber()).toBeCloseTo(0.048, 6);
    const usage = UsageSummaryDTOSchema.parse(json(await app.app.inject({ method: 'GET', url: '/v1/usage', headers: alice.auth })));
    expect(usage.today.estimatedCostUsd).toBeCloseTo(0.048, 6);
  });
});
