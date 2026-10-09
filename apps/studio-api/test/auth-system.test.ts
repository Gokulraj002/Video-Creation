import { HeuristicMockProvider } from '@vc/ai-director';
import { MeDTOSchema, SystemConfigDTOSchema, ApiErrorSchema } from '@vc/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDirectorFactory } from '../src/director/factory';
import { InlineDirectorQueue } from '../src/queue/inline';
import { STUDIO_API_VERSION } from '../src/version';
import {
  buildTestApp,
  createUser,
  disconnectTestPrisma,
  json,
  testConfig,
  testPrisma,
  truncateAll,
  type TestApp,
} from './helpers';

const prisma = testPrisma();
let t: TestApp;

beforeEach(async () => {
  await truncateAll(prisma);
  t = await buildTestApp();
});
afterEach(async () => {
  await t.close();
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe('health', () => {
  it('GET /health is public', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, version: STUDIO_API_VERSION });
  });
});

describe('authentication', () => {
  it('401 UNAUTHORIZED without a bearer token', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    const body = ApiErrorSchema.parse(json(res));
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 with a malformed, unknown or revoked token', async () => {
    const user = await createUser(prisma, 'a@example.com');
    for (const authorization of ['Basic abc', 'Bearer nope', `Bearer ${user.token}x`, user.token]) {
      const res = await t.app.inject({ method: 'GET', url: '/v1/projects', headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
      expect(ApiErrorSchema.parse(json(res)).error.code).toBe('UNAUTHORIZED');
    }
    await prisma.apiToken.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    const revoked = await t.app.inject({ method: 'GET', url: '/v1/me', headers: user.auth });
    expect(revoked.statusCode).toBe(401);
  });

  it('GET /v1/me returns the token owner and records lastUsedAt', async () => {
    const user = await createUser(prisma, 'me@example.com', 'Ada');
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: user.auth });
    expect(res.statusCode).toBe(200);
    expect(MeDTOSchema.parse(json(res))).toEqual({ id: user.id, email: 'me@example.com', name: 'Ada' });
    const token = await prisma.apiToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(token.lastUsedAt).not.toBeNull();
    expect(token.tokenHash).not.toContain(user.token);
  });

  it('unknown routes return the error envelope', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(json(res)).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/system/config', () => {
  it('describes provider, queue, limits, engines and templates', async () => {
    const user = await createUser(prisma, 'sys@example.com');
    const res = await t.app.inject({ method: 'GET', url: '/v1/system/config', headers: user.auth });
    expect(res.statusCode).toBe(200);
    const dto = SystemConfigDTOSchema.parse(json(res));
    expect(dto.aiProvider).toEqual({ name: 'mock', model: 'mock-director-v1', mode: 'mock', configured: true });
    expect(dto.queueDriver).toBe('inline');
    expect(dto.limits.maxDurationSeconds).toBe(7200);
    const engines = Object.fromEntries(dto.engines.map((e) => [e.engine, e]));
    expect(engines['motion2d']).toEqual({ engine: 'motion2d', available: true, reason: null });
    expect(engines['three']?.available).toBe(true);
    for (const e of ['footage', 'image', 'screen'] as const) {
      expect(engines[e]).toEqual({ engine: e, available: false, reason: 'requires uploaded assets (Milestone 3)' });
    }
    expect(engines['generated']).toEqual({
      engine: 'generated',
      available: false,
      reason: 'no video generation provider configured',
    });
    expect(dto.templates.map((x) => x.id)).toContain('title-card');
    expect(dto.promptVersion.length).toBeGreaterThan(0);
  });

  it('never returns secrets (anthropic configuration)', async () => {
    const secretKey = 'sk-ant-api03-SUPERSECRET-0123456789abcdef';
    const devToken = 'dev-token-0123456789-0123456789-0123456789';
    const config = testConfig({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: secretKey,
      STUDIO_DEV_API_TOKEN: devToken,
    });
    // A real AnthropicProvider is constructed (no network call is made by this endpoint).
    const factory = createDirectorFactory(config);
    const queue = new InlineDirectorQueue(async () => undefined);
    const app = await buildApp({ config, prisma, queue, directorFactory: factory, logger: false });
    try {
      const user = await createUser(prisma, 'live@example.com');
      const res = await app.inject({ method: 'GET', url: '/v1/system/config', headers: user.auth });
      expect(res.statusCode).toBe(200);
      const dto = SystemConfigDTOSchema.parse(json(res));
      expect(dto.aiProvider).toMatchObject({ name: 'anthropic', model: 'claude-opus-5-5', mode: 'live', configured: true });
      expect(res.body).not.toContain(secretKey);
      expect(res.body).not.toContain('SUPERSECRET');
      expect(res.body).not.toContain(devToken);
      expect(res.body).not.toContain('postgres://');
    } finally {
      await app.close();
      await queue.close();
    }
  });

  it('reports an injected provider', async () => {
    await t.close();
    t = await buildTestApp({ provider: new HeuristicMockProvider() });
    const user = await createUser(prisma, 'inj@example.com');
    const res = await t.app.inject({ method: 'GET', url: '/v1/system/config', headers: user.auth });
    expect(SystemConfigDTOSchema.parse(json(res)).aiProvider.mode).toBe('mock');
  });
});

describe('rate limiting', () => {
  it('limits requests per token and answers 429 RATE_LIMITED', async () => {
    await t.close();
    t = await buildTestApp({ env: { RATE_LIMIT_PER_MINUTE: '3' } });
    const a = await createUser(prisma, 'rl-a@example.com');
    const b = await createUser(prisma, 'rl-b@example.com');
    for (let i = 0; i < 3; i++) {
      expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: a.auth })).statusCode).toBe(200);
    }
    const limited = await t.app.inject({ method: 'GET', url: '/v1/me', headers: a.auth });
    expect(limited.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(json(limited)).error.code).toBe('RATE_LIMITED');
    // Another token has its own budget; /health is exempt.
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: b.auth })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
  });
});

describe('CORS', () => {
  it('allows configured origins only', async () => {
    const allowed = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/projects',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const denied = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/projects',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
