import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaDirectorCache } from '../src/director/prisma-cache';
import { hashToken } from '../src/lib/tokens';
import { seedDevUser } from '../src/scripts/seed';
import { buildTestApp, disconnectTestPrisma, json, testPrisma, truncateAll } from './helpers';

const prisma = testPrisma();

beforeEach(async () => {
  await truncateAll(prisma);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe('seedDevUser', () => {
  it('upserts the dev user and a hashed token idempotently; the token authenticates', async () => {
    const raw = 'dev-token-for-tests-0123456789abcdef-XYZ';
    const first = await seedDevUser(prisma, 'dev@localhost', raw);
    const second = await seedDevUser(prisma, 'dev@localhost', raw);
    expect(second).toEqual(first);
    expect(await prisma.user.count()).toBe(1);
    const tokens = await prisma.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenHash).toBe(hashToken(raw));
    expect(JSON.stringify(tokens)).not.toContain(raw);

    const t = await buildTestApp();
    try {
      const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${raw}` } });
      expect(res.statusCode).toBe(200);
      expect(json<{ email: string }>(res).email).toBe('dev@localhost');
    } finally {
      await t.close();
    }

    // Re-seeding un-revokes the token.
    await prisma.apiToken.updateMany({ data: { revokedAt: new Date() } });
    await seedDevUser(prisma, 'dev@localhost', raw);
    expect((await prisma.apiToken.findFirstOrThrow()).revokedAt).toBeNull();
  });
});

describe('PrismaDirectorCache', () => {
  const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const entry = (output: unknown) => ({
    stage: 'storyboard' as const,
    chunk: 'c1',
    output,
    usage,
    provider: 'mock',
    model: 'mock-director-v1',
    createdAt: new Date().toISOString(),
  });

  it('stores entries with their stage, counts hits and treats corrupt rows as misses', async () => {
    const cache = new PrismaDirectorCache(prisma, 'user-a');
    expect(await cache.get('missing')).toBeNull();
    await cache.set('k1', entry({ title: 'Hello', nested: [1, 2, { a: null }] }));
    const hit = await cache.get('k1', { stage: 'storyboard', chunk: 'c1' });
    expect(hit).toMatchObject({
      stage: 'storyboard',
      chunk: 'c1',
      output: { title: 'Hello', nested: [1, 2, { a: null }] },
      usage,
      provider: 'mock',
      model: 'mock-director-v1',
    });
    await cache.get('k1');
    const row = await prisma.directorCacheEntry.findUniqueOrThrow({ where: { key: cache.storageKey('k1') } });
    expect(row.stage).toBe('storyboard');
    expect(row.chunk).toBe('c1');
    expect(row.hits).toBe(2);
    expect(row.lastHitAt).not.toBeNull();
    // The raw director key is never stored as-is.
    expect(row.key).not.toBe('k1');

    // Overwrite keeps one row.
    await cache.set('k1', entry({ title: 'Bye' }));
    expect(await prisma.directorCacheEntry.count()).toBe(1);
    expect((await cache.get('k1'))?.output).toEqual({ title: 'Bye' });

    await prisma.directorCacheEntry.update({ where: { key: row.key }, data: { usage: { bogus: true } } });
    expect(await cache.get('k1')).toBeNull();
  });

  it('is scoped per owner: the same director key never hits across users', async () => {
    const a = new PrismaDirectorCache(prisma, 'user-a');
    const b = new PrismaDirectorCache(prisma, 'user-b');
    await a.set('shared-key', entry({ secret: 'A' }));
    expect(await b.get('shared-key')).toBeNull();
    await b.set('shared-key', entry({ secret: 'B' }));
    expect((await a.get('shared-key'))?.output).toEqual({ secret: 'A' });
    expect((await b.get('shared-key'))?.output).toEqual({ secret: 'B' });
    expect(await prisma.directorCacheEntry.count()).toBe(2);
    expect(() => new PrismaDirectorCache(prisma, '')).toThrow();
  });
});
