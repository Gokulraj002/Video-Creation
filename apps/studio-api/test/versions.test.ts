import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiErrorSchema,
  DirectorRunDTOSchema,
  ProjectDetailDTOSchema,
  ProjectVersionDTOSchema,
  ProjectVersionSummaryDTOSchema,
} from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SizeBoundedLru } from '../src/lib/lru';
import { VERSION_CACHE_CONTROL, versionEtag } from '../src/routes/projects';
import { VERSION_LIST_LIMIT } from '../src/services/projects';
import {
  buildTestApp,
  createUser,
  disconnectTestPrisma,
  insertProject,
  json,
  sampleRequest,
  testPrisma,
  truncateAll,
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

/** Creates a project through the API and directs it once (version 1, real timeline). */
async function directedProject(app: TestApp): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: '/v1/projects', headers: alice.auth, payload: sampleRequest() });
  const projectId = ProjectDetailDTOSchema.parse(json(res)).id;
  const run = await app.app.inject({ method: 'POST', url: `/v1/projects/${projectId}/director-runs`, headers: alice.auth });
  DirectorRunDTOSchema.parse(json(run));
  await app.queue.onIdle();
  return projectId;
}

const getVersion = (app: TestApp, projectId: string, version: number, headers: Record<string, string> = {}) =>
  app.app.inject({
    method: 'GET',
    url: `/v1/projects/${projectId}/versions/${version}`,
    headers: { ...alice.auth, ...headers },
  });

describe('version list', () => {
  it('stores summary columns at write time and lists from them (never the timeline JSON)', async () => {
    const app = await setup();
    const projectId = await directedProject(app);
    const row = await prisma.projectVersion.findFirstOrThrow({ where: { projectId } });
    expect(row.sceneCount).toBeGreaterThan(0);
    expect(row.durationInFrames).toBe(900);
    expect(row.fps).toBe(30);
    // Break the JSON: the list is unaffected because it only reads the columns.
    await prisma.projectVersion.update({ where: { id: row.id }, data: { timeline: { broken: true } } });
    const list = await app.app.inject({ method: 'GET', url: `/v1/projects/${projectId}/versions`, headers: alice.auth });
    expect(list.statusCode).toBe(200);
    expect(z.array(ProjectVersionSummaryDTOSchema).parse(json(list))).toEqual([
      {
        id: row.id,
        projectId,
        version: 1,
        schemaVersion: 1,
        createdAt: row.createdAt.toISOString(),
        sceneCount: row.sceneCount,
        durationInFrames: 900,
        fps: 30,
      },
    ]);
  });

  it(`returns only the latest ${VERSION_LIST_LIMIT} versions, newest first`, async () => {
    const app = await setup();
    const projectId = await insertProject(prisma, alice.id);
    await prisma.projectVersion.createMany({
      data: Array.from({ length: VERSION_LIST_LIMIT + 5 }, (_, i) => ({
        projectId,
        version: i + 1,
        schemaVersion: 1,
        timeline: {},
        artifacts: {},
        sceneCount: i,
        durationInFrames: 30 * (i + 1),
        fps: 30,
      })),
    });
    const list = z
      .array(ProjectVersionSummaryDTOSchema)
      .parse(json(await app.app.inject({ method: 'GET', url: `/v1/projects/${projectId}/versions`, headers: alice.auth })));
    expect(list).toHaveLength(VERSION_LIST_LIMIT);
    expect(list[0]?.version).toBe(VERSION_LIST_LIMIT + 5);
    expect(list[list.length - 1]?.version).toBe(6);
    expect(list[0]?.durationInFrames).toBe(30 * (VERSION_LIST_LIMIT + 5));
  });
});

describe('migration backfill of the version summary columns', () => {
  it('derives scene_count / duration_in_frames / fps from existing timeline JSON', async () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations');
    const migration = readdirSync(dir).find((d) => d.endsWith('_run_reservations_heartbeat_version_summary'));
    if (migration === undefined) throw new Error('migration not found');
    const sql = readFileSync(resolve(dir, migration, 'migration.sql'), 'utf8');
    const backfill = /-- BEGIN version-summary backfill[^\n]*\n([\s\S]*?)-- END version-summary backfill/.exec(sql)?.[1];
    if (backfill === undefined) throw new Error('backfill block not found');

    const projectId = await insertProject(prisma, alice.id);
    const timelines = [
      { scenes: [{}, {}, {}], durationInFrames: 900, settings: { fps: 25 } },
      { scenes: [], durationInFrames: 12.6, settings: { fps: 60 } },
      { scenes: 'nope', durationInFrames: 'x', settings: {} },
      'not an object',
    ];
    for (const [i, timeline] of timelines.entries()) {
      await prisma.projectVersion.create({
        data: { projectId, version: i + 1, schemaVersion: 1, timeline, artifacts: {}, sceneCount: 99, durationInFrames: 99, fps: 99 },
      });
    }
    await prisma.$executeRawUnsafe(backfill);
    const rows = await prisma.projectVersion.findMany({
      where: { projectId },
      orderBy: { version: 'asc' },
      select: { sceneCount: true, durationInFrames: true, fps: true },
    });
    expect(rows).toEqual([
      { sceneCount: 3, durationInFrames: 900, fps: 25 },
      { sceneCount: 0, durationInFrames: 13, fps: 60 },
      { sceneCount: 0, durationInFrames: 1, fps: 30 },
      { sceneCount: 0, durationInFrames: 1, fps: 30 },
    ]);
  });
});

describe('GET version: ETag, immutable caching and the parsed-DTO cache', () => {
  it('sends a strong ETag + immutable Cache-Control and answers 304 to If-None-Match', async () => {
    const app = await setup();
    const projectId = await directedProject(app);
    const res = await getVersion(app, projectId, 1);
    expect(res.statusCode).toBe(200);
    const dto = ProjectVersionDTOSchema.parse(json(res));
    expect(res.headers['etag']).toBe(versionEtag(dto.id));
    expect(res.headers['cache-control']).toBe(VERSION_CACHE_CONTROL);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const notModified = await getVersion(app, projectId, 1, { 'if-none-match': `W/"other", ${versionEtag(dto.id)}` });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect((await getVersion(app, projectId, 1, { 'if-none-match': '"stale"' })).statusCode).toBe(200);
    // Still owner-scoped and 404 for unknown versions, even with a matching If-None-Match.
    const bob = await createUser(prisma, 'bob@example.com');
    const foreign = await app.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/versions/1`,
      headers: { ...bob.auth, 'if-none-match': versionEtag(dto.id) },
    });
    expect(foreign.statusCode).toBe(404);
    expect((await getVersion(app, projectId, 2)).statusCode).toBe(404);
  });

  it('validates a stored version once per process (cached serialized DTO)', async () => {
    const app = await setup();
    const projectId = await directedProject(app);
    const first = await getVersion(app, projectId, 1);
    expect(first.statusCode).toBe(200);
    // Corrupt the row: the cached, already validated DTO keeps being served by this process…
    await prisma.projectVersion.updateMany({ where: { projectId }, data: { timeline: { broken: true } } });
    const second = await getVersion(app, projectId, 1);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    // …while a process without the cache entry reads (and validates) the row again.
    const fresh = await setup({ env: { VERSION_CACHE_MAX_BYTES: '0' } });
    const res = await getVersion(fresh, projectId, 1);
    expect(res.statusCode).toBe(500);
    expect(ApiErrorSchema.parse(json(res)).error.code).toBe('DATA_INTEGRITY');
  });
});

describe('corrupt stored rows → 500 DATA_INTEGRITY (not 400, no details)', () => {
  it('a corrupt project row breaks reads with a generic 500 that leaks nothing', async () => {
    const app = await setup();
    const res = await app.app.inject({ method: 'POST', url: '/v1/projects', headers: alice.auth, payload: sampleRequest() });
    const projectId = ProjectDetailDTOSchema.parse(json(res)).id;
    await prisma.project.update({ where: { id: projectId }, data: { genre: 'secret-corrupt-genre' } });
    const list = await app.app.inject({ method: 'GET', url: '/v1/projects', headers: alice.auth });
    expect(list.statusCode).toBe(500);
    const body = ApiErrorSchema.parse(json(list));
    expect(body.error.code).toBe('DATA_INTEGRITY');
    expect(body.error.details).toBeUndefined();
    expect(list.body).not.toContain('secret-corrupt-genre');
    expect(list.body).not.toContain('genre');

    await prisma.project.update({ where: { id: projectId }, data: { genre: 'promo', request: { prompt: 42 } } });
    expect((await app.app.inject({ method: 'GET', url: '/v1/projects', headers: alice.auth })).statusCode).toBe(200);
    const detail = await app.app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: alice.auth });
    expect(detail.statusCode).toBe(500);
    expect(ApiErrorSchema.parse(json(detail)).error.code).toBe('DATA_INTEGRITY');
  });

  it('a corrupt version row → 500 DATA_INTEGRITY', async () => {
    const app = await setup({ env: { VERSION_CACHE_MAX_BYTES: '0' } });
    const projectId = await directedProject(app);
    await prisma.projectVersion.updateMany({ where: { projectId }, data: { artifacts: { nope: 1 } } });
    const res = await getVersion(app, projectId, 1);
    expect(res.statusCode).toBe(500);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error).toEqual({ code: 'DATA_INTEGRITY', message: expect.any(String) });
    expect(res.body).not.toContain('nope');
  });
});

describe('SizeBoundedLru', () => {
  it('evicts least recently used entries beyond the size budget', () => {
    const lru = new SizeBoundedLru(10);
    lru.set('a', 'aaaa');
    lru.set('b', 'bbbb');
    expect(lru.get('a')).toBe('aaaa'); // a is now most recent
    lru.set('c', 'cccc'); // 12 > 10 → evict b
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('aaaa');
    expect(lru.get('c')).toBe('cccc');
    expect(lru.totalSize).toBe(8);
    lru.set('huge', 'x'.repeat(11)); // larger than the budget: not cached
    expect(lru.get('huge')).toBeUndefined();
    lru.set('a', 'a');
    expect(lru.totalSize).toBe(5);
    expect(lru.count).toBe(2);
  });
});
