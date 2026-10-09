import { ApiErrorSchema } from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateApiToken, hashToken } from '../src/lib/tokens';
import {
  buildTestApp,
  createUser,
  disconnectTestPrisma,
  json,
  testPrisma,
  truncateAll,
  type BuildTestAppOptions,
  type TestApp,
} from './helpers';

const prisma = testPrisma();
let t: TestApp | null = null;

async function setup(options: BuildTestAppOptions = {}): Promise<TestApp> {
  if (t !== null) await t.close();
  t = await buildTestApp(options);
  return t;
}

beforeEach(async () => {
  await truncateAll(prisma);
});
afterEach(async () => {
  if (t !== null) await t.close();
  t = null;
});
afterAll(async () => {
  await disconnectTestPrisma();
});

const me = (app: TestApp, headers: Record<string, string>, remoteAddress = '203.0.113.7') =>
  app.app.inject({ method: 'GET', url: '/v1/me', headers, remoteAddress });

describe('per-IP limit on failed authentication (before auth)', () => {
  it('missing and bogus tokens are limited per IP; a blocked IP is refused before any token lookup', async () => {
    const app = await setup({ env: { RATE_LIMIT_UNAUTH_PER_MINUTE: '3', RATE_LIMIT_PER_MINUTE: '1000' } });
    const user = await createUser(prisma, 'ip@example.com');
    expect((await me(app, {})).statusCode).toBe(401);
    expect((await me(app, { authorization: `Bearer ${'x'.repeat(40)}` })).statusCode).toBe(401);
    expect((await me(app, { authorization: 'Basic abc' })).statusCode).toBe(401);
    const limited = await me(app, { authorization: `Bearer ${generateApiToken()}` });
    expect(limited.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(json(limited)).error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Even a valid token from that IP is refused for the rest of the window: the guard runs before auth,
    // so the token is not looked up (lastUsedAt stays unset).
    expect((await me(app, user.auth)).statusCode).toBe(429);
    expect((await prisma.apiToken.findFirstOrThrow({ where: { userId: user.id } })).lastUsedAt).toBeNull();
    // Other IPs have their own budget.
    expect((await me(app, user.auth, '198.51.100.9')).statusCode).toBe(200);
    expect((await me(app, {}, '198.51.100.10')).statusCode).toBe(401);
  });

  it('successful requests do not consume the failed-auth budget (e.g. the web server proxying for users)', async () => {
    const app = await setup({ env: { RATE_LIMIT_UNAUTH_PER_MINUTE: '2', RATE_LIMIT_PER_MINUTE: '1000' } });
    const user = await createUser(prisma, 'ok@example.com');
    for (let i = 0; i < 10; i++) expect((await me(app, user.auth)).statusCode).toBe(200);
    expect((await me(app, {})).statusCode).toBe(401);
    expect((await me(app, {})).statusCode).toBe(401);
    expect((await me(app, {})).statusCode).toBe(429);
  });
});

describe('per-user limit (after auth)', () => {
  it('is keyed on the user: all of a user’s tokens share RATE_LIMIT_PER_MINUTE', async () => {
    const app = await setup({ env: { RATE_LIMIT_PER_MINUTE: '3', RATE_LIMIT_UNAUTH_PER_MINUTE: '100' } });
    const a = await createUser(prisma, 'a@example.com');
    const secondToken = generateApiToken();
    await prisma.apiToken.create({ data: { userId: a.id, label: 'second', tokenHash: hashToken(secondToken) } });
    const b = await createUser(prisma, 'b@example.com');
    const first = await me(app, a.auth);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    expect((await me(app, a.auth)).statusCode).toBe(200);
    expect((await me(app, { authorization: `Bearer ${secondToken}` })).statusCode).toBe(200);
    const limited = await me(app, { authorization: `Bearer ${secondToken}` });
    expect(limited.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(json(limited)).error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // Another user (same IP) is unaffected; /health and /ready are never limited.
    expect((await me(app, b.auth)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await app.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    }
  });
});
