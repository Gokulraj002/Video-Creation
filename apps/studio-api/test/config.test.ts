import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

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
      cacheEnabled: true,
      pricingOverrides: null,
      workerConcurrency: 2,
    });
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
    expect(c.quotas).toEqual({ directorRunsPerDay: 50, directorUsdPerDay: 25 });
    expect(c.rateLimitPerMinute).toBe(300);
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
});
