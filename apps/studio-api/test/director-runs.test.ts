import {
  HeuristicMockProvider,
  ProviderRefusalError,
  ScriptedMockProvider,
  type StructuredGenerationRequest,
} from '@vc/ai-director';
import {
  ApiErrorSchema,
  DirectorRunDTOSchema,
  ProjectDetailDTOSchema,
  ProjectVersionDTOSchema,
  ProjectVersionSummaryDTOSchema,
  TimelineSchema,
  type DirectorRunDTO,
} from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { processDirectorRun } from '../src/director/process-run';
import { silentLogger } from '../src/lib/logger';
import {
  buildTestApp,
  createUser,
  deferred,
  disconnectTestPrisma,
  json,
  sampleRequest,
  testPrisma,
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

async function createProject(app: TestApp, user: TestUser, overrides: Parameters<typeof sampleRequest>[0] = {}) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: user.auth,
    payload: sampleRequest(overrides),
  });
  expect(res.statusCode, res.body).toBe(201);
  return ProjectDetailDTOSchema.parse(json(res));
}

async function startRun(app: TestApp, user: TestUser, projectId: string): Promise<DirectorRunDTO> {
  const res = await app.app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/director-runs`,
    headers: user.auth,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(202);
  return DirectorRunDTOSchema.parse(json(res));
}

async function getRun(app: TestApp, user: TestUser, runId: string): Promise<DirectorRunDTO> {
  const res = await app.app.inject({ method: 'GET', url: `/v1/director-runs/${runId}`, headers: user.auth });
  expect(res.statusCode, res.body).toBe(200);
  return DirectorRunDTOSchema.parse(json(res));
}

/** Scripted provider that answers like the heuristic mock (so outputs stay valid). */
function heuristicScripted(
  before?: (req: StructuredGenerationRequest<unknown>, callIndex: number) => Promise<void> | void,
): ScriptedMockProvider {
  const heuristic = new HeuristicMockProvider();
  return new ScriptedMockProvider(async (req, callIndex) => {
    await before?.(req, callIndex);
    const result = await heuristic.generateStructured(req);
    return result.output;
  });
}

describe('director runs end-to-end (inline queue + heuristic mock)', () => {
  it('produces version 1 with a valid timeline and usage', async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const queued = await startRun(app, alice, project.id);
    expect(queued).toMatchObject({
      projectId: project.id,
      status: 'queued',
      provider: 'mock',
      model: 'mock-director-v1',
      usage: null,
      error: null,
      versionNumber: null,
      startedAt: null,
      finishedAt: null,
    });
    // 30 s → 1 chapter → brief + outline + 5 chapter stages + compile.
    expect(queued.progress).toEqual({ completedSteps: 0, totalSteps: 8, currentStage: null, message: 'Queued' });

    const directing = ProjectDetailDTOSchema.parse(
      json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: alice.auth })),
    );
    expect(directing.status).toBe('directing');
    expect(directing.latestRun?.id).toBe(queued.id);

    await app.queue.onIdle();

    const run = await getRun(app, alice, queued.id);
    expect(run.status).toBe('succeeded');
    expect(run.versionNumber).toBe(1);
    expect(run.error).toBeNull();
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.progress.totalSteps).toBe(8);
    expect(run.progress.completedSteps).toBe(run.progress.totalSteps);
    expect(run.usage).not.toBeNull();
    expect(run.usage?.totals.calls).toBeGreaterThan(0);
    expect(run.usage?.totals.inputTokens).toBeGreaterThan(0);
    expect(run.usage?.totals.outputTokens).toBeGreaterThan(0);
    expect(run.usage?.totals.estimatedCostUsd).toBe(0);

    const row = await prisma.directorRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.inputTokens).toBe(run.usage?.totals.inputTokens);
    expect(row.outputTokens).toBe(run.usage?.totals.outputTokens);
    expect(row.promptVersion).toBe(app.factory.promptVersion);

    const detail = ProjectDetailDTOSchema.parse(
      json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: alice.auth })),
    );
    expect(detail.status).toBe('ready');
    expect(detail.currentVersion).toBe(1);
    expect(detail.latestRun?.status).toBe('succeeded');

    const versions = z
      .array(ProjectVersionSummaryDTOSchema)
      .parse(json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}/versions`, headers: alice.auth })));
    expect(versions).toHaveLength(1);

    const vRes = await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}/versions/1`, headers: alice.auth });
    expect(vRes.statusCode).toBe(200);
    const version = ProjectVersionDTOSchema.parse(json(vRes));
    const timeline = TimelineSchema.parse(version.timeline);
    expect(version.version).toBe(1);
    expect(version.schemaVersion).toBe(1);
    expect(timeline.settings.fps).toBe(30);
    expect(timeline.settings.width).toBe(1920);
    expect(timeline.settings.height).toBe(1080);
    expect(timeline.durationInFrames).toBe(900);
    expect(timeline.scenes.reduce((sum, s) => sum + s.durationInFrames, 0)).toBe(900);
    expect(version.artifacts.storyboard.scenes.length).toBe(timeline.scenes.length);
    expect(versions[0]).toEqual({
      id: version.id,
      projectId: project.id,
      version: 1,
      schemaVersion: 1,
      createdAt: version.createdAt,
      sceneCount: timeline.scenes.length,
      durationInFrames: 900,
      fps: 30,
    });
  });

  it('a second run creates version 2 entirely from the cache (0 new tokens)', async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const first = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const firstDone = await getRun(app, alice, first.id);
    expect(firstDone.status).toBe('succeeded');
    const cacheRows = await prisma.directorCacheEntry.count();
    expect(cacheRows).toBe(firstDone.usage?.totals.calls);

    const second = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const run2 = await getRun(app, alice, second.id);
    expect(run2.status).toBe('succeeded');
    expect(run2.versionNumber).toBe(2);
    expect(run2.usage?.totals).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    });
    expect(run2.usage?.totals.cachedCalls).toBe(run2.usage?.totals.calls);
    expect(run2.usage?.stages.every((s) => s.cached)).toBe(true);
    const hits = await prisma.directorCacheEntry.aggregate({ _sum: { hits: true } });
    expect(hits._sum.hits).toBe(run2.usage?.totals.cachedCalls);

    const detail = ProjectDetailDTOSchema.parse(
      json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: alice.auth })),
    );
    expect(detail.currentVersion).toBe(2);
    const versions = z
      .array(ProjectVersionSummaryDTOSchema)
      .parse(json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}/versions`, headers: alice.auth })));
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    const list = z
      .array(DirectorRunDTOSchema)
      .parse(json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}/director-runs`, headers: alice.auth })));
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);

    // Deleting a directed project cascades to its versions and runs.
    const del = await app.app.inject({ method: 'DELETE', url: `/v1/projects/${project.id}`, headers: alice.auth });
    expect(del.statusCode).toBe(204);
    expect(await prisma.projectVersion.count()).toBe(0);
    expect(await prisma.directorRun.count()).toBe(0);
  });

  it('DIRECTOR_CACHE=off makes the provider do the work again', async () => {
    const provider = heuristicScripted();
    const app = await setup({ provider, env: { DIRECTOR_CACHE: 'off' } });
    const project = await createProject(app, alice, { durationSeconds: 10 });
    await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const callsAfterFirst = provider.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await startRun(app, alice, project.id);
    await app.queue.onIdle();
    expect(provider.calls.length).toBe(callsAfterFirst * 2);
    expect(await prisma.directorCacheEntry.count()).toBe(0);
  });
});

describe('run guards', () => {
  it('409 RUN_ACTIVE while a run is queued or running', async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    const res = await app.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/director-runs`,
      headers: alice.auth,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('RUN_ACTIVE');
    expect(body.error.details).toEqual({ runId: run.id });
    await app.queue.onIdle();
  });

  it('concurrent starts create exactly one run', async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.app.inject({
          method: 'POST',
          url: `/v1/projects/${project.id}/director-runs`,
          headers: alice.auth,
          payload: {},
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 409, 409, 409, 409]);
    await app.queue.onIdle();
    expect(await prisma.directorRun.count()).toBe(1);
  });

  it('429 QUOTA_EXCEEDED when the daily run limit is reached', async () => {
    const app = await setup({ env: { LIMIT_DIRECTOR_RUNS_PER_DAY: '1' } });
    const project = await createProject(app, alice);
    await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const res = await app.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/director-runs`,
      headers: alice.auth,
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(json(res)).error.code).toBe('QUOTA_EXCEEDED');
    // Quotas are per user.
    const bobProject = await createProject(app, bob);
    await startRun(app, bob, bobProject.id);
    await app.queue.onIdle();
  });

  it('429 QUOTA_EXCEEDED when the estimated spend today reached the USD limit', async () => {
    const app = await setup({ env: { LIMIT_DIRECTOR_USD_PER_DAY: '5' } });
    const project = await createProject(app, alice);
    await prisma.directorRun.create({
      data: {
        projectId: project.id,
        requestedById: alice.id,
        status: 'SUCCEEDED',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        promptVersion: 'test',
        progress: {},
        estimatedCostUsd: '5.250000',
        finishedAt: new Date(),
      },
    });
    const res = await app.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/director-runs`,
      headers: alice.auth,
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(body.error.message).toMatch(/spend/);
  });

  it('accepts a missing body and rejects a non-object body', async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const bad = await app.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/director-runs`,
      headers: alice.auth,
      payload: [1, 2],
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/director-runs`,
      headers: alice.auth,
    });
    expect(ok.statusCode).toBe(202);
    await app.queue.onIdle();
  });
});

describe('cancellation', () => {
  it('cancels a queued run; the worker then skips it', async () => {
    const provider = heuristicScripted();
    const app = await setup({ provider });
    const project = await createProject(app, alice);
    // A QUEUED run that has not been picked up yet (created directly, not enqueued).
    const queued = await prisma.directorRun.create({
      data: {
        projectId: project.id,
        requestedById: alice.id,
        status: 'QUEUED',
        provider: 'mock',
        model: 'mock-director-v1',
        promptVersion: app.factory.promptVersion,
        progress: { completedSteps: 0, totalSteps: 0, currentStage: null, message: 'Queued' },
      },
    });
    await prisma.project.update({ where: { id: project.id }, data: { status: 'DIRECTING' } });

    const res = await app.app.inject({ method: 'POST', url: `/v1/director-runs/${queued.id}/cancel`, headers: alice.auth });
    expect(res.statusCode).toBe(200);
    const cancelled = DirectorRunDTOSchema.parse(json(res));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();

    // A late job delivery is a no-op: process-run only claims QUEUED runs.
    await processDirectorRun(queued.id, {
      prisma,
      config: app.config,
      directorFactory: app.factory,
      logger: silentLogger,
    });
    expect(provider.calls).toHaveLength(0);
    expect((await getRun(app, alice, queued.id)).status).toBe('cancelled');
    const detail = ProjectDetailDTOSchema.parse(
      json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: alice.auth })),
    );
    expect(detail.status).toBe('draft');
    expect(detail.currentVersion).toBeNull();
  });

  it('cancels a running run: the director aborts and no version is created', async () => {
    const gate = deferred();
    let reachedGate = false;
    const provider = heuristicScripted(async (_req, callIndex) => {
      if (callIndex === 1) {
        reachedGate = true;
        await gate.promise;
      }
    });
    const app = await setup({ provider, cancelPollMs: 20 });
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    await waitFor(async () => reachedGate);
    expect((await getRun(app, alice, run.id)).status).toBe('running');

    const res = await app.app.inject({ method: 'POST', url: `/v1/director-runs/${run.id}/cancel`, headers: alice.auth });
    expect(res.statusCode).toBe(200);
    expect(DirectorRunDTOSchema.parse(json(res)).status).toBe('cancelled');
    gate.resolve();
    await app.queue.onIdle();

    const final = await getRun(app, alice, run.id);
    expect(final.status).toBe('cancelled');
    expect(final.versionNumber).toBeNull();
    expect(provider.calls.length).toBeLessThanOrEqual(3);
    expect(await prisma.projectVersion.count()).toBe(0);
    const project2 = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(project2.status).toBe('DRAFT');

    const again = await app.app.inject({ method: 'POST', url: `/v1/director-runs/${run.id}/cancel`, headers: alice.auth });
    expect(again.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(json(again)).error.code).toBe('RUN_NOT_ACTIVE');
  });

  it('409 when cancelling a finished run', async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const res = await app.app.inject({ method: 'POST', url: `/v1/director-runs/${run.id}/cancel`, headers: alice.auth });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(json(res)).error.code).toBe('RUN_NOT_ACTIVE');
  });
});

describe('failures', () => {
  it('provider refusal → run FAILED with the director error code; project FAILED', async () => {
    const provider = new ScriptedMockProvider(() => {
      throw new ProviderRefusalError('The model declined to help', { category: 'policy', explanation: null });
    });
    const app = await setup({ provider });
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const failed = await getRun(app, alice, run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PROVIDER_REFUSAL');
    expect(failed.error?.message).toContain('declined');
    expect(failed.finishedAt).not.toBeNull();
    const detail = ProjectDetailDTOSchema.parse(
      json(await app.app.inject({ method: 'GET', url: `/v1/projects/${project.id}`, headers: alice.auth })),
    );
    expect(detail.status).toBe('failed');
    expect(detail.latestRun?.error?.code).toBe('PROVIDER_REFUSAL');
  });

  it('invalid output after all repairs → VALIDATION_FAILED; project stays READY when it has a version', async () => {
    let broken = false;
    const heuristic = new HeuristicMockProvider();
    const provider = new ScriptedMockProvider(async (req) => {
      if (broken) return { nonsense: true };
      return (await heuristic.generateStructured(req)).output;
    });
    const app = await setup({ provider, env: { DIRECTOR_CACHE: 'off', DIRECTOR_MAX_REPAIR_ATTEMPTS: '1' } });
    const project = await createProject(app, alice);
    await startRun(app, alice, project.id);
    await app.queue.onIdle();
    broken = true;
    const run = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const failed = await getRun(app, alice, run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('VALIDATION_FAILED');
    const detail = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { currentVersion: true } });
    expect(detail.status).toBe('READY');
    expect(detail.currentVersion?.version).toBe(1);
  });

  it('unexpected errors → INTERNAL with a generic message', async () => {
    const provider = new ScriptedMockProvider(() => {
      throw new TypeError('secret internal detail at /srv/app.ts:42');
    });
    const app = await setup({ provider });
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const failed = await getRun(app, alice, run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('INTERNAL');
    expect(failed.error?.message).not.toContain('secret internal detail');
  });

  it('DIRECTOR_RUN_TIMEOUT_MS aborts slow runs with TIMEOUT', async () => {
    const provider = heuristicScripted(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const app = await setup({ provider, env: { DIRECTOR_RUN_TIMEOUT_MS: '30' } });
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    const failed = await getRun(app, alice, run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('TIMEOUT');
    expect(await prisma.projectVersion.count()).toBe(0);
  });
});

describe('run isolation', () => {
  it("user B gets 404 on user A's runs", async () => {
    const app = await setup();
    const project = await createProject(app, alice);
    const run = await startRun(app, alice, project.id);
    await app.queue.onIdle();
    for (const [method, url] of [
      ['GET', `/v1/director-runs/${run.id}`],
      ['POST', `/v1/director-runs/${run.id}/cancel`],
      ['GET', `/v1/projects/${project.id}/versions/1`],
    ] as const) {
      const res = await app.app.inject({ method, url, headers: bob.auth });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(ApiErrorSchema.parse(json(res)).error.code).toBe('NOT_FOUND');
    }
    const missing = await app.app.inject({ method: 'GET', url: '/v1/director-runs/does-not-exist', headers: alice.auth });
    expect(missing.statusCode).toBe(404);
  });
});
