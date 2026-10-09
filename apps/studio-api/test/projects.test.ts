import {
  ApiErrorSchema,
  ProjectDetailDTOSchema,
  ProjectSummaryPageSchema,
  ProjectVersionSummaryDTOSchema,
} from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildTestApp,
  createUser,
  disconnectTestPrisma,
  json,
  sampleRequest,
  testPrisma,
  truncateAll,
  type TestApp,
  type TestUser,
} from './helpers';

/** `total` is optional in ProjectSummaryPageSchema; the API always sends it. */
const TotalSchema = z.object({ total: z.number().int().min(0) });

const prisma = testPrisma();
let t: TestApp;
let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await truncateAll(prisma);
  t = await buildTestApp();
  alice = await createUser(prisma, 'alice@example.com', 'Alice');
  bob = await createUser(prisma, 'bob@example.com', 'Bob');
});
afterEach(async () => {
  await t.close();
});
afterAll(async () => {
  await disconnectTestPrisma();
});

async function create(user: TestUser, overrides: Parameters<typeof sampleRequest>[0] = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: user.auth,
    payload: sampleRequest(overrides),
  });
  expect(res.statusCode, res.body).toBe(201);
  return ProjectDetailDTOSchema.parse(json(res));
}

describe('projects CRUD', () => {
  it('creates a draft project with defaults applied', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: alice.auth,
      payload: {
        title: 'Minimal',
        prompt: 'Explain photosynthesis to kids',
        genre: 'explainer',
        durationSeconds: 75,
        aspectRatio: '9:16',
        resolution: '720p',
        voiceOver: { enabled: false },
        music: { enabled: false },
      },
    });
    expect(res.statusCode).toBe(201);
    const dto = ProjectDetailDTOSchema.parse(json(res));
    expect(dto).toMatchObject({
      title: 'Minimal',
      status: 'draft',
      genre: 'explainer',
      durationSeconds: 75,
      aspectRatio: '9:16',
      currentVersion: null,
      latestRun: null,
    });
    expect(dto.request.fps).toBe(30);
    expect(dto.request.language).toBe('en');
    expect(dto.request.referenceAssetIds).toEqual([]);

    const get = await t.app.inject({ method: 'GET', url: `/v1/projects/${dto.id}`, headers: alice.auth });
    expect(get.statusCode).toBe(200);
    expect(ProjectDetailDTOSchema.parse(json(get))).toEqual(dto);
  });

  it('lists owner projects by updatedAt desc with cursor pagination and the total count', async () => {
    for (let i = 0; i < 5; i++) await create(alice, { title: `P${i}` });
    await create(bob, { title: 'Bob project' });

    const page1Res = await t.app.inject({ method: 'GET', url: '/v1/projects?limit=2', headers: alice.auth });
    const page1 = ProjectSummaryPageSchema.parse(json(page1Res));
    expect(page1.items.map((p) => p.title)).toEqual(['P4', 'P3']);
    expect(page1.nextCursor).not.toBeNull();
    // `total` = the owner's project count (independent of the page).
    expect(TotalSchema.parse(json(page1Res)).total).toBe(5);
    const page2 = ProjectSummaryPageSchema.parse(
      json(
        await t.app.inject({
          method: 'GET',
          url: `/v1/projects?limit=2&cursor=${page1.nextCursor ?? ''}`,
          headers: alice.auth,
        }),
      ),
    );
    expect(page2.items.map((p) => p.title)).toEqual(['P2', 'P1']);
    const page3 = ProjectSummaryPageSchema.parse(
      json(
        await t.app.inject({
          method: 'GET',
          url: `/v1/projects?limit=2&cursor=${page2.nextCursor ?? ''}`,
          headers: alice.auth,
        }),
      ),
    );
    expect(page3.items.map((p) => p.title)).toEqual(['P0']);
    expect(page3.nextCursor).toBeNull();

    const all = ProjectSummaryPageSchema.parse(
      json(await t.app.inject({ method: 'GET', url: '/v1/projects', headers: alice.auth })),
    );
    expect(all.items).toHaveLength(5);
    expect(all.items.every((p) => p.title !== 'Bob project')).toBe(true);
    const bobPage = json(await t.app.inject({ method: 'GET', url: '/v1/projects', headers: bob.auth }));
    expect(TotalSchema.parse(bobPage).total).toBe(1);
  });

  it('cursors are positions: rows touched or deleted between pages cause no duplicates or errors', async () => {
    for (let i = 0; i < 6; i++) await create(alice, { title: `P${i}` });
    const page = async (cursor: string | null) =>
      ProjectSummaryPageSchema.parse(
        json(
          await t.app.inject({
            method: 'GET',
            url: `/v1/projects?limit=2${cursor !== null ? `&cursor=${cursor}` : ''}`,
            headers: alice.auth,
          }),
        ),
      );
    const p1 = await page(null);
    expect(p1.items.map((p) => p.title)).toEqual(['P5', 'P4']);
    // The last row of page 1 is updated (e.g. a run starts) and moves to the top before page 2 is fetched.
    const touched = p1.items[1];
    if (touched === undefined) throw new Error('expected two items');
    await prisma.project.update({ where: { id: touched.id }, data: { title: 'P4 (touched)' } });
    const p2 = await page(p1.nextCursor);
    expect(p2.items.map((p) => p.title)).toEqual(['P3', 'P2']);
    // The anchor of the next cursor is deleted: the next page still works.
    const anchor = p2.items[1];
    if (anchor === undefined) throw new Error('expected two items');
    await prisma.project.delete({ where: { id: anchor.id } });
    const p3 = await page(p2.nextCursor);
    expect(p3.items.map((p) => p.title)).toEqual(['P1', 'P0']);
    const seen = [...p1.items, ...p2.items, ...p3.items].map((p) => p.id);
    expect(new Set(seen).size).toBe(seen.length);
    // Garbage and raw ids are not cursors.
    for (const cursor of ['%%%', touched.id, Buffer.from('not-a-date~abc').toString('base64url')]) {
      const res = await t.app.inject({ method: 'GET', url: `/v1/projects?cursor=${cursor}`, headers: alice.auth });
      expect(res.statusCode, cursor).toBe(400);
      expect(ApiErrorSchema.parse(json(res)).error.code).toBe('INVALID_CURSOR');
    }
  });

  it('rejects bad pagination parameters', async () => {
    for (const url of ['/v1/projects?limit=0', '/v1/projects?limit=101', '/v1/projects?limit=abc']) {
      const res = await t.app.inject({ method: 'GET', url, headers: alice.auth });
      expect(res.statusCode, url).toBe(400);
      expect(ApiErrorSchema.parse(json(res)).error.code).toBe('VALIDATION_ERROR');
    }
    const bobProject = await create(bob);
    const res = await t.app.inject({ method: 'GET', url: `/v1/projects?cursor=${bobProject.id}`, headers: alice.auth });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(json(res)).error.code).toBe('INVALID_CURSOR');
  });

  it('deletes a project (204) and then 404s', async () => {
    const p = await create(alice);
    const del = await t.app.inject({ method: 'DELETE', url: `/v1/projects/${p.id}`, headers: alice.auth });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    const get = await t.app.inject({ method: 'GET', url: `/v1/projects/${p.id}`, headers: alice.auth });
    expect(get.statusCode).toBe(404);
    const again = await t.app.inject({ method: 'DELETE', url: `/v1/projects/${p.id}`, headers: alice.auth });
    expect(again.statusCode).toBe(404);
  });

  it('refuses to delete while a run is active (409 RUN_ACTIVE)', async () => {
    const p = await create(alice);
    await prisma.directorRun.create({
      data: {
        projectId: p.id,
        requestedById: alice.id,
        status: 'RUNNING',
        provider: 'mock',
        model: 'mock-director-v1',
        promptVersion: 'test',
        progress: {},
      },
    });
    const del = await t.app.inject({ method: 'DELETE', url: `/v1/projects/${p.id}`, headers: alice.auth });
    expect(del.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(json(del)).error.code).toBe('RUN_ACTIVE');
  });

  it('lists no versions for a fresh project and 404s unknown versions', async () => {
    const p = await create(alice);
    const list = await t.app.inject({ method: 'GET', url: `/v1/projects/${p.id}/versions`, headers: alice.auth });
    expect(list.statusCode).toBe(200);
    expect(z.array(ProjectVersionSummaryDTOSchema).parse(json(list))).toEqual([]);
    const v1 = await t.app.inject({ method: 'GET', url: `/v1/projects/${p.id}/versions/1`, headers: alice.auth });
    expect(v1.statusCode).toBe(404);
    const bad = await t.app.inject({ method: 'GET', url: `/v1/projects/${p.id}/versions/zero`, headers: alice.auth });
    expect(bad.statusCode).toBe(400);
  });
});

describe('validation and limits', () => {
  it('400 VALIDATION_ERROR with issues for an invalid body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: alice.auth,
      payload: { ...sampleRequest(), title: '', genre: 'nope', durationSeconds: -5 },
    });
    expect(res.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const issues = z.array(z.object({ path: z.string(), message: z.string() })).parse(body.error.details);
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'genre', 'durationSeconds']));
  });

  it('400 for custom aspect ratio without dimensions, malformed JSON and empty body', async () => {
    const custom = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: alice.auth,
      payload: sampleRequest({ aspectRatio: 'custom' }),
    });
    expect(custom.statusCode).toBe(400);
    const malformed = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...alice.auth, 'content-type': 'application/json' },
      payload: '{"title": ',
    });
    expect(malformed.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(json(malformed)).error.code).toBe('INVALID_BODY');
    const empty = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...alice.auth, 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(json(empty)).error.code).toBe('VALIDATION_ERROR');
  });

  it('413 for bodies over 1 MB', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...alice.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...sampleRequest(), styleNotes: 'x'.repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(json(res)).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('422 LIMIT_EXCEEDED when the request exceeds configured limits', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: alice.auth,
      payload: sampleRequest({
        durationSeconds: 7201,
        fps: 120,
        aspectRatio: 'custom',
        resolution: 'custom',
        customWidth: 4096,
        customHeight: 2160,
      }),
    });
    expect(res.statusCode).toBe(422);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('LIMIT_EXCEEDED');
    const details = z
      .object({ violations: z.array(z.object({ code: z.string(), limit: z.number(), actual: z.number() })) })
      .parse(body.error.details);
    expect(details.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(['MAX_DURATION_SECONDS', 'MAX_FPS', 'MAX_WIDTH']),
    );
    expect(await prisma.project.count()).toBe(0);
  });

  it('limits are configurable (long videos allowed when the limit is raised)', async () => {
    await t.close();
    t = await buildTestApp({ env: { LIMIT_MAX_DURATION_SECONDS: '36000' } });
    const p = await create(alice, { durationSeconds: 4 * 3600, genre: 'long-form' });
    expect(p.durationSeconds).toBe(14400);
  });
});

describe('owner isolation', () => {
  it("user B gets 404 on user A's project and versions", async () => {
    const p = await create(alice);
    for (const [method, url] of [
      ['GET', `/v1/projects/${p.id}`],
      ['DELETE', `/v1/projects/${p.id}`],
      ['GET', `/v1/projects/${p.id}/versions`],
      ['GET', `/v1/projects/${p.id}/versions/1`],
      ['GET', `/v1/projects/${p.id}/director-runs`],
      ['POST', `/v1/projects/${p.id}/director-runs`],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: bob.auth, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(ApiErrorSchema.parse(json(res)).error.code).toBe('NOT_FOUND');
    }
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.directorRun.count()).toBe(0);
  });
});
