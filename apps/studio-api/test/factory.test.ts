import {
  HeuristicMockProvider,
  ProviderTruncatedError,
  type AIProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from '@vc/ai-director';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDirectorFactory, MeteredProvider, type ProviderCallUsage } from '../src/director/factory';
import { LiveUsageMeter } from '../src/director/process-run';
import { testConfig, tokens } from './helpers';

const request: StructuredGenerationRequest<unknown> = {
  stage: 'brief',
  chunk: null,
  system: 's',
  prompt: 'p',
  input: {},
  schema: z.unknown(),
  schemaName: 'x',
  maxOutputTokens: 100,
};

class StubProvider implements AIProvider {
  readonly name = 'stub';
  readonly model = 'claude-opus-5-5';
  readonly mode = 'live' as const;
  readonly configFingerprint = 'fp-123';
  constructor(private readonly answer: () => StructuredGenerationResult) {}
  async generateStructured<T>(_req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult> {
    return this.answer();
  }
}

const result = (overrides: Partial<StructuredGenerationResult> = {}): StructuredGenerationResult => ({
  output: {},
  usage: tokens(100, 10),
  provider: 'stub',
  model: 'claude-opus-5-5',
  stopReason: 'end_turn',
  latencyMs: 1,
  ...overrides,
});

describe('MeteredProvider (live spend metering)', () => {
  it('forwards identity incl. the cache-key fingerprint and reports every billed request', async () => {
    const calls: ProviderCallUsage[] = [];
    let next: () => StructuredGenerationResult = () => result();
    const metered = new MeteredProvider(new StubProvider(() => next()), (c) => calls.push(c));
    expect([metered.name, metered.model, metered.mode, metered.configFingerprint]).toEqual(['stub', 'claude-opus-5-5', 'live', 'fp-123']);
    expect(new MeteredProvider(new HeuristicMockProvider(), () => undefined).configFingerprint).toBe(
      new HeuristicMockProvider().configFingerprint,
    );

    await metered.generateStructured(request);
    // Server-side fallback: each hop is priced by its own model.
    next = () =>
      result({
        model: 'claude-sonnet-5-5',
        usageByModel: [
          { model: 'claude-opus-5-5', usage: tokens(50) },
          { model: 'claude-sonnet-5-5', usage: tokens(50, 10) },
        ],
      });
    await metered.generateStructured(request);
    next = () => {
      throw new ProviderTruncatedError('cut off', { usage: tokens(7, 16_000) });
    };
    await expect(metered.generateStructured(request)).rejects.toBeInstanceOf(ProviderTruncatedError);
    expect(calls).toEqual([
      { model: 'claude-opus-5-5', usage: tokens(100, 10) },
      { model: 'claude-opus-5-5', usage: tokens(50) },
      { model: 'claude-sonnet-5-5', usage: tokens(50, 10) },
      { model: 'claude-opus-5-5', usage: tokens(7, 16_000) },
    ]);

    const factory = createDirectorFactory(testConfig());
    const meter = new LiveUsageMeter(factory.pricing);
    for (const c of calls) meter.add(c);
    expect(meter.callCount).toBe(4);
    // opus: (150 + 7) in × $4 + (10 + 16000) out × $20; sonnet: 50 × $2 + 10 × $10 (per MTok).
    expect(meter.costUsd).toBeCloseTo((157 * 4 + 16_010 * 20 + 50 * 2 + 10 * 10) / 1e6, 9);
    expect(meter.columns()).toMatchObject({ inputTokens: 207, outputTokens: 16_020 });
  });

  it('the factory estimates the run cost ceiling for its provider (0 for the mock)', () => {
    expect(createDirectorFactory(testConfig()).estimateRunCostCeilingUsd({ chapterCount: 25 })).toBe(0);
    const live = createDirectorFactory(testConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MAX_OUTPUT_TOKENS: '4000' }));
    // ANTHROPIC_MAX_OUTPUT_TOKENS caps every stage's output budget: 7 calls × 4k output + 80k input tokens.
    expect(live.estimateRunCostCeilingUsd({ chapterCount: 1 })).toBeCloseTo((7 * 4000 * 20 + 80_000 * 5) / 1e6, 9);
  });
});
