import { describe, expect, it } from 'vitest';
import { ConfigError, effectiveRunTimeoutMs, loadConfig, MAX_TIMER_MS } from '../src/config';

const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig(BASE);
    expect(c.host).toBe('0.0.0.0');
    expect(c.port).toBe(4100);
    expect(c.queueDriver).toBe('bullmq');
    expect(c.corsOrigins).toEqual(['http://localhost:3000']);
    expect(c.ai.provider).toBe('mock');
    expect(c.ai.anthropic).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxOutputTokens: 16000,
      fallbacks: 'default',
      structuredOutput: 'json_schema',
    });
    expect(c.director).toMatchObject({
      maxRepairAttempts: 2,
      runTimeoutMs: 1_800_000,
      stepTimeoutMs: 120_000,
      cacheEnabled: true,
      pricingOverrides: null,
      workerConcurrency: 2,
      heartbeatStaleMs: 60_000,
      queuedStaleMs: 600_000,
      reaperIntervalMs: 30_000,
    });
    expect(c.databasePool).toEqual({ max: 10, connectionTimeoutMs: 5_000 });
    expect(c.queue).toEqual({ enqueueTimeoutMs: 3_000, jobLockMs: 300_000 });
    expect(c.limits).toEqual({
      maxDurationSeconds: 7200,
      maxWidth: 3840,
      maxHeight: 3840,
      maxFps: 60,
      maxScenes: 2000,
      maxChapters: 200,
      maxTracks: 50,
      maxAssets: 500,
      maxPromptChars: 20000,
    });
    expect(c.quotas).toEqual({ directorRunsPerDay: 50, directorUsdPerDay: 25, activeRunsPerUser: 2 });
    expect(c.rateLimitPerMinute).toBe(300);
    expect(c.rateLimitUnauthPerMinute).toBe(60);
    expect(c.versionCacheMaxBytes).toBe(64 * 1024 * 1024);
    expect(c.dev.userEmail).toBe('dev@localhost');
  });

  it('parses overrides, comma lists and treats empty strings as unset', () => {
    const c = loadConfig({
      ...BASE,
      STUDIO_API_PORT: '5000',
      CORS_ORIGINS: 'http://a.test, https://b.test ,',
      LIMIT_MAX_DURATION_SECONDS: '36000',
      DIRECTOR_CACHE: 'off',
      LIMIT_DIRECTOR_USD_PER_DAY: '2.5',
      ANTHROPIC_API_KEY: '',
      QUEUE_DRIVER: 'inline',
    });
    expect(c.port).toBe(5000);
    expect(c.corsOrigins).toEqual(['http://a.test', 'https://b.test']);
    expect(c.limits.maxDurationSeconds).toBe(36000);
    expect(c.director.cacheEnabled).toBe(false);
    expect(c.quotas.directorUsdPerDay).toBe(2.5);
    expect(c.ai.anthropic.apiKey).toBeUndefined();
    expect(c.queueDriver).toBe('inline');
  });

  it('requires ANTHROPIC_API_KEY iff AI_PROVIDER=anthropic', () => {
    expect(() => loadConfig({ ...BASE, AI_PROVIDER: 'anthropic' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' })).toThrow(/ANTHROPIC_API_KEY/);
    const c = loadConfig({ ...BASE, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key' });
    expect(c.ai.provider).toBe('anthropic');
    expect(c.ai.anthropic.apiKey).toBe('sk-ant-test-key');
  });

  it('validates DIRECTOR_PRICING_JSON', () => {
    const pricing = { 'my-model': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 } };
    expect(loadConfig({ ...BASE, DIRECTOR_PRICING_JSON: JSON.stringify(pricing) }).director.pricingOverrides).toEqual(
      pricing,
    );
    expect(() => loadConfig({ ...BASE, DIRECTOR_PRICING_JSON: '{nope' })).toThrow(/valid JSON/);
    expect(() =>
      loadConfig({ ...BASE, DIRECTOR_PRICING_JSON: JSON.stringify({ m: { inputPerMTok: -1 } }) }),
    ).toThrow(/DIRECTOR_PRICING_JSON/);
  });

  it('rejects invalid values and never echoes secret values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...BASE, QUEUE_DRIVER: 'kafka' })).toThrow(/QUEUE_DRIVER/);
    expect(() => loadConfig({ ...BASE, STUDIO_API_PORT: 'abc' })).toThrow(/STUDIO_API_PORT/);
    expect(() => loadConfig({ ...BASE, LIMIT_MAX_SCENES: '0' })).toThrow(/LIMIT_MAX_SCENES/);
    const secret = 'short-secret-token';
    try {
      loadConfig({ ...BASE, STUDIO_DEV_API_TOKEN: secret });
      expect.unreachable('short dev token must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).toMatch(/STUDIO_DEV_API_TOKEN/);
      expect(String(err)).not.toContain(secret);
    }
  });

  it('scales the run timeout with the plan size', () => {
    const c = loadConfig(BASE);
    // 30 s video: 8 steps × 2 min < 30 min minimum.
    expect(effectiveRunTimeoutMs(c, 8)).toBe(1_800_000);
    // 2 h long-form video: 25 chapters → 2 + 5 × 25 + 1 = 128 steps × 2 min.
    expect(effectiveRunTimeoutMs(c, 128)).toBe(128 * 120_000);
    const noScale = loadConfig({ ...BASE, DIRECTOR_STEP_TIMEOUT_MS: '0', DIRECTOR_RUN_TIMEOUT_MS: '5000' });
    expect(effectiveRunTimeoutMs(noScale, 500)).toBe(5000);
  });
});

describe('timer bounds (setTimeout fires immediately above 2^31 - 1 ms)', () => {
  it('rejects timeouts above MAX_TIMER_MS and clamps the scaled run timeout to it', () => {
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    expect(() => loadConfig({ ...BASE, DIRECTOR_RUN_TIMEOUT_MS: '2592000000' })).toThrow(/DIRECTOR_RUN_TIMEOUT_MS/);
    expect(() => loadConfig({ ...BASE, DIRECTOR_STEP_TIMEOUT_MS: '2147483648' })).toThrow(/DIRECTOR_STEP_TIMEOUT_MS/);
    expect(() => loadConfig({ ...BASE, DIRECTOR_JOB_LOCK_MS: '1000' })).toThrow(/DIRECTOR_JOB_LOCK_MS/);
    expect(() => loadConfig({ ...BASE, DIRECTOR_REAPER_INTERVAL_MS: '10' })).toThrow(/DIRECTOR_REAPER_INTERVAL_MS/);
    expect(loadConfig({ ...BASE, DIRECTOR_REAPER_INTERVAL_MS: '0' }).director.reaperIntervalMs).toBe(0);
    const max = loadConfig({ ...BASE, DIRECTOR_RUN_TIMEOUT_MS: String(MAX_TIMER_MS) });
    expect(max.director.runTimeoutMs).toBe(MAX_TIMER_MS);
    // 100 min per step × 423 steps (2 h social short) would be ~2.5e9 ms.
    const perStep = loadConfig({ ...BASE, DIRECTOR_STEP_TIMEOUT_MS: '6000000' });
    expect(effectiveRunTimeoutMs(perStep, 423)).toBe(MAX_TIMER_MS);
    expect(effectiveRunTimeoutMs(loadConfig({ ...BASE, DIRECTOR_STEP_TIMEOUT_MS: String(MAX_TIMER_MS) }), 1_000_000)).toBe(
      MAX_TIMER_MS,
    );
  });

  it('parses the new quota, rate-limit, pool and queue settings', () => {
    const c = loadConfig({
      ...BASE,
      LIMIT_ACTIVE_RUNS_PER_USER: '5',
      RATE_LIMIT_UNAUTH_PER_MINUTE: '7',
      DATABASE_POOL_MAX: '25',
      DATABASE_CONNECTION_TIMEOUT_MS: '1500',
      QUEUE_ENQUEUE_TIMEOUT_MS: '800',
      DIRECTOR_JOB_LOCK_MS: '600000',
      DIRECTOR_HEARTBEAT_STALE_MS: '45000',
      DIRECTOR_QUEUED_STALE_MS: '120000',
      VERSION_CACHE_MAX_BYTES: '0',
    });
    expect(c.quotas.activeRunsPerUser).toBe(5);
    expect(c.rateLimitUnauthPerMinute).toBe(7);
    expect(c.databasePool).toEqual({ max: 25, connectionTimeoutMs: 1500 });
    expect(c.queue).toEqual({ enqueueTimeoutMs: 800, jobLockMs: 600_000 });
    expect(c.director.heartbeatStaleMs).toBe(45_000);
    expect(c.director.queuedStaleMs).toBe(120_000);
    expect(c.versionCacheMaxBytes).toBe(0);
    expect(() => loadConfig({ ...BASE, LIMIT_ACTIVE_RUNS_PER_USER: '0' })).toThrow(/LIMIT_ACTIVE_RUNS_PER_USER/);
    expect(() => loadConfig({ ...BASE, DATABASE_POOL_MAX: '0' })).toThrow(/DATABASE_POOL_MAX/);
  });
});
