import { UsageSummaryDTOSchema } from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOfUtcDay, startOfUtcMonth, usageSummary } from '../src/services/usage';
import {
  buildTestApp,
  createUser,
  disconnectTestPrisma,
  json,
  testPrisma,
  truncateAll,
  type TestApp,
  type TestUser,
} from './helpers';

const prisma = testPrisma();
let t: TestApp;
let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await truncateAll(prisma);
  t = await buildTestApp();
  alice = await createUser(prisma, 'alice@example.com');
  bob = await createUser(prisma, 'bob@example.com');
});
afterEach(async () => {
  await t.close();
});
afterAll(async () => {
  await disconnectTestPrisma();
});

async function insertRun(user: TestUser, createdAt: Date, tokens: number, cost: string): Promise<void> {
  const project =
    (await prisma.project.findFirst({ where: { ownerId: user.id } })) ??
    (await prisma.project.create({
      data: {
        ownerId: user.id,
        title: 'p',
        genre: 'promo',
        durationSeconds: 10,
        aspectRatio: '16:9',
        request: {},
      },
    }));
  await prisma.directorRun.create({
    data: {
      projectId: project.id,
      requestedById: user.id,
      status: 'SUCCEEDED',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: 'test',
      progress: {},
      inputTokens: tokens,
      outputTokens: tokens * 2,
      cacheReadTokens: tokens * 3,
      cacheWriteTokens: tokens * 4,
      estimatedCostUsd: cost,
      createdAt,
    },
  });
}

describe('usage', () => {
  it('UTC window helpers', () => {
    const now = new Date('2026-03-01T00:30:00+02:00'); // 2026-02-28T22:30Z
    expect(startOfUtcDay(now).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(startOfUtcMonth(now).toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('aggregates today (UTC) and the current month per user', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    await insertRun(alice, new Date('2026-10-15T00:00:00Z'), 100, '0.500000');
    await insertRun(alice, new Date('2026-10-15T11:59:00Z'), 10, '0.012345');
    await insertRun(alice, new Date('2026-10-03T08:00:00Z'), 1000, '2.000000');
    await insertRun(alice, new Date('2026-09-30T23:59:59Z'), 5000, '9.000000');
    await insertRun(bob, new Date('2026-10-15T10:00:00Z'), 7, '1.000000');

    const summary = UsageSummaryDTOSchema.parse(await usageSummary(prisma, alice.id, now));
    expect(summary.today).toEqual({
      runs: 2,
      inputTokens: 110,
      outputTokens: 220,
      cacheReadTokens: 330,
      cacheWriteTokens: 440,
      estimatedCostUsd: 0.512345,
    });
    expect(summary.month.runs).toBe(3);
    expect(summary.month.inputTokens).toBe(1110);
    expect(summary.month.estimatedCostUsd).toBeCloseTo(2.512345, 6);
  });

  it('GET /v1/usage returns the caller’s usage (zeros when empty)', async () => {
    const empty = await t.app.inject({ method: 'GET', url: '/v1/usage', headers: alice.auth });
    expect(empty.statusCode).toBe(200);
    const zero = { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
    expect(UsageSummaryDTOSchema.parse(json(empty))).toEqual({ today: zero, month: zero });

    await insertRun(alice, new Date(), 50, '0.250000');
    await insertRun(bob, new Date(), 99, '3.000000');
    const res = await t.app.inject({ method: 'GET', url: '/v1/usage', headers: alice.auth });
    const dto = UsageSummaryDTOSchema.parse(json(res));
    expect(dto.today).toEqual({
      runs: 1,
      inputTokens: 50,
      outputTokens: 100,
      cacheReadTokens: 150,
      cacheWriteTokens: 200,
      estimatedCostUsd: 0.25,
    });
    expect(dto.month.runs).toBe(1);
  });
});
