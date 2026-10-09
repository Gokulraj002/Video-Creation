import { describe, expect, it } from 'vitest';
import {
  AIDirector,
  DEFAULT_PRICING,
  estimateCostUsd,
  parsePricingOverrides,
  summarizeUsage,
  UsageTracker,
  ZERO_USAGE,
} from '../src';
import { delegatingProvider, makeRequest } from './helpers';

const M = 1_000_000;
const usage = (i: number, o: number, r = 0, w = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w });

describe('estimateCostUsd', () => {
  it('prices claude-opus-5-5 at $4 / $20 per MTok with $0.20 cache reads and 1.25× cache writes', () => {
    expect(estimateCostUsd('claude-opus-5-5', usage(M, 0))).toEqual({ costUsd: 4, pricingKnown: true });
    expect(estimateCostUsd('claude-opus-5-5', usage(0, M)).costUsd).toBe(20);
    expect(estimateCostUsd('claude-opus-5-5', usage(0, 0, M)).costUsd).toBeCloseTo(0.2, 10);
    expect(estimateCostUsd('claude-opus-5-5', usage(0, 0, 0, M)).costUsd).toBe(5);
    // 12k input + 3k output + 40k cache read + 8k cache write
    expect(estimateCostUsd('claude-opus-5-5', usage(12_000, 3_000, 40_000, 8_000)).costUsd).toBeCloseTo(0.048 + 0.06 + 0.008 + 0.04, 10);
  });

  it('knows the other configured models', () => {
    expect(estimateCostUsd('claude-opus-5', usage(M, M)).costUsd).toBe(30);
    expect(estimateCostUsd('claude-sonnet-5-5', usage(M, M, M, M)).costUsd).toBeCloseTo(14.7, 10);
    expect(estimateCostUsd('claude-haiku-5-5', usage(M, M, M, M)).costUsd).toBeCloseTo(0.735, 10);
    expect(estimateCostUsd('claude-opus-4-8', usage(M, 0)).costUsd).toBe(5);
    expect(estimateCostUsd('mock-director-v1', usage(M, M))).toEqual({ costUsd: 0, pricingKnown: true });
  });

  it('accepts dated snapshot ids and reports unknown models as 0 with pricingKnown false', () => {
    expect(estimateCostUsd('claude-opus-5-5-20261001', usage(M, 0)).costUsd).toBe(4);
    expect(estimateCostUsd('gpt-unknown', usage(M, M))).toEqual({ costUsd: 0, pricingKnown: false });
    expect(estimateCostUsd('claude-opus-5-1', usage(M, M)).pricingKnown).toBe(false);
  });

  it('supports pricing overrides from JSON', () => {
    const table = parsePricingOverrides('{"my-model":{"inputPerMTok":1,"outputPerMTok":2,"cacheReadPerMTok":0.1,"cacheWritePerMTok":1.25}}');
    expect(estimateCostUsd('my-model', usage(M, M), table).costUsd).toBe(3);
    expect(table['claude-opus-5-5']).toEqual(DEFAULT_PRICING['claude-opus-5-5']);
    expect(() => parsePricingOverrides('{"bad":{"inputPerMTok":-1}}')).toThrow(TypeError);
    expect(() => parsePricingOverrides('not json')).toThrow(TypeError);
    expect(parsePricingOverrides(undefined)).toEqual({ ...DEFAULT_PRICING });
  });
});

describe('UsageTracker', () => {
  it('accumulates stage usage, cost and call counts', () => {
    const tracker = new UsageTracker();
    tracker.record({ stage: 'brief', chunk: null, provider: 'anthropic', model: 'claude-opus-5-5', attempts: 2, cached: false, usage: usage(1000, 500, 2000, 100), latencyMs: 1200 });
    tracker.record({ stage: 'outline', chunk: null, provider: 'anthropic', model: 'claude-opus-5-5', attempts: 1, cached: true, usage: usage(999, 999), latencyMs: 0 });
    tracker.record({ stage: 'script', chunk: 'c1', provider: 'x', model: 'unknown-model', attempts: 1, cached: false, usage: usage(10, 10), latencyMs: 5 });
    const report = tracker.report();
    expect(report.stages).toHaveLength(3);
    expect(report.stages[1]?.usage).toEqual(ZERO_USAGE);
    expect(report.stages[1]?.estimatedCostUsd).toBe(0);
    expect(report.stages[2]?.pricingKnown).toBe(false);
    const briefCost = (1000 * 4 + 500 * 20 + 2000 * 0.2 + 100 * 5) / M;
    expect(report.totals.estimatedCostUsd).toBeCloseTo(briefCost, 12);
    expect(report.totals).toMatchObject({ inputTokens: 1010, outputTokens: 510, cacheReadTokens: 2000, cacheWriteTokens: 100, calls: 3, cachedCalls: 1 });
    expect(summarizeUsage([])).toEqual({ stages: [], totals: { ...ZERO_USAGE, estimatedCostUsd: 0, calls: 0, cachedCalls: 0 } });
  });

  it('the director applies its pricing table to served models', async () => {
    const provider = delegatingProvider();
    const pricing = { ...DEFAULT_PRICING, 'scripted-mock-v1': { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } };
    const result = await new AIDirector({ provider, pricing }).planProject({ request: makeRequest() });
    const tokens = result.usage.totals.inputTokens + result.usage.totals.outputTokens;
    expect(tokens).toBeGreaterThan(0);
    expect(result.usage.totals.estimatedCostUsd).toBeCloseTo(tokens / M, 12);
    expect(result.usage.stages.every((s) => s.pricingKnown)).toBe(true);
  });
});
