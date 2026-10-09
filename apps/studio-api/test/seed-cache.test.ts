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
  it('stores entries, counts hits and treats corrupt rows as misses', async () => {
    const cache = new PrismaDirectorCache(prisma);
    expect(await cache.get('missing')).toBeNull();
    const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await cache.set('k1', {
      output: { title: 'Hello', nested: [1, 2, { a: null }] },
      usage,
      provider: 'mock',
      model: 'mock-director-v1',
      createdAt: new Date().toISOString(),
    });
    const hit = await cache.get('k1');
    expect(hit).toMatchObject({
      output: { title: 'Hello', nested: [1, 2, { a: null }] },
      usage,
      provider: 'mock',
      model: 'mock-director-v1',
    });
    await cache.get('k1');
    const row = await prisma.directorCacheEntry.findUniqueOrThrow({ where: { key: 'k1' } });
    expect(row.hits).toBe(2);
    expect(row.lastHitAt).not.toBeNull();

    // Overwrite keeps one row.
    await cache.set('k1', {
      output: { title: 'Bye' },
      usage,
      provider: 'mock',
      model: 'mock-director-v1',
      createdAt: new Date().toISOString(),
    });
    expect(await prisma.directorCacheEntry.count()).toBe(1);
    expect((await cache.get('k1'))?.output).toEqual({ title: 'Bye' });

    await prisma.directorCacheEntry.update({ where: { key: 'k1' }, data: { usage: { bogus: true } } });
    expect(await cache.get('k1')).toBeNull();
  });
});
