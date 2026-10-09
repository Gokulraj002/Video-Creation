import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING,
  estimateRunCostCeilingUsd,
  HEURISTIC_MOCK_MODEL,
  planStructure,
  STAGE_INPUT_TOKEN_ESTIMATE,
  STAGE_MAX_OUTPUT_TOKENS,
  stageCallCounts,
} from '../src';
import { makeRequest } from './helpers';

describe('estimateRunCostCeilingUsd', () => {
  const promo = planStructure(makeRequest({ genre: 'promo', durationSeconds: 30 }));
  const longForm = planStructure(makeRequest({ genre: 'long-form', durationSeconds: 7200 }));

  it('counts one call per stage per chapter (plus brief and outline)', () => {
    expect(stageCallCounts({ chapterCount: 3 })).toEqual({
      brief: 1,
      outline: 1,
      script: 3,
      storyboard: 3,
      shotList: 3,
      engineSelection: 3,
      sceneSpecs: 3,
    });
  });

  it('prices every call at its max output plus the input budget (claude-opus-5-5)', () => {
    // Outputs: 8k + 12k + 16k×3 + 12k + 16k = 96k tokens × $20/MTok = $1.92.
    // Inputs: 8k×3 + 12k×3 + 20k = 80k tokens × max($4 input, $5 cache write)/MTok = $0.40.
    expect(promo.chapterCount).toBe(1);
    expect(estimateRunCostCeilingUsd(promo, 'claude-opus-5-5')).toBeCloseTo(2.32, 9);
    // Each further chapter adds 76k output + 64k input tokens = $1.84; brief + outline = $0.48.
    expect(longForm.chapterCount).toBe(25);
    expect(estimateRunCostCeilingUsd(longForm, 'claude-opus-5-5')).toBeCloseTo(0.48 + 25 * 1.84, 9);
    // Same arithmetic from the exported tables.
    const outputs = Object.values(STAGE_MAX_OUTPUT_TOKENS).reduce((a, b) => a + b, 0);
    const inputs = Object.values(STAGE_INPUT_TOKEN_ESTIMATE).reduce((a, b) => a + b, 0);
    expect(estimateRunCostCeilingUsd(promo, 'claude-opus-5-5')).toBeCloseTo((outputs * 20 + inputs * 5) / 1e6, 9);
  });

  it('is 0 for the mock model and for models without known pricing', () => {
    expect(estimateRunCostCeilingUsd(longForm, HEURISTIC_MOCK_MODEL)).toBe(0);
    expect(estimateRunCostCeilingUsd(longForm, 'unknown-model')).toBe(0);
    expect(estimateRunCostCeilingUsd({ chapterCount: 0 }, 'claude-opus-5-5')).toBeCloseTo(0.48, 9);
  });

  it('accepts dated snapshots, pricing overrides, a provider output cap and repair budgets', () => {
    expect(estimateRunCostCeilingUsd(promo, 'claude-opus-5-5-20261001')).toBeCloseTo(2.32, 9);
    const pricing = { ...DEFAULT_PRICING, 'my-model': { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } };
    expect(estimateRunCostCeilingUsd(promo, 'my-model', pricing)).toBeCloseTo((96_000 + 80_000) / 1e6, 9);
    // ANTHROPIC_MAX_OUTPUT_TOKENS=4000: 7 calls × 4k output.
    expect(estimateRunCostCeilingUsd(promo, 'claude-opus-5-5', DEFAULT_PRICING, { maxOutputTokensCap: 4000 })).toBeCloseTo(
      (7 * 4000 * 20 + 80_000 * 5) / 1e6,
      9,
    );
    expect(estimateRunCostCeilingUsd(promo, 'claude-opus-5-5', DEFAULT_PRICING, { attemptsPerCall: 3 })).toBeCloseTo(3 * 2.32, 9);
    expect(
      estimateRunCostCeilingUsd(promo, 'claude-opus-5-5', DEFAULT_PRICING, { inputTokens: { sceneSpecs: 0, brief: 0 } }),
    ).toBeCloseTo(2.32 - (28_000 * 5) / 1e6, 9);
  });

  it('is deterministic and rounds up to whole micro-dollars', () => {
    const value = estimateRunCostCeilingUsd(longForm, 'claude-sonnet-5-5');
    expect(estimateRunCostCeilingUsd(longForm, 'claude-sonnet-5-5')).toBe(value);
    expect(Number.isInteger(Math.round(value * 1e6))).toBe(true);
    expect(Math.abs(value * 1e6 - Math.round(value * 1e6))).toBeLessThan(1e-3);
  });
});
