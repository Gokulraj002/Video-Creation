import type { StructurePlan } from './planning';
import { DEFAULT_PRICING, findPricing, type PricingTable } from './pricing';
import { LLM_STAGES, STAGE_MAX_OUTPUT_TOKENS, type LlmStage } from './stages';

/**
 * Generous per-call input-token budget by stage (system prompt + rendered stage input). Measured stage inputs
 * of the heuristic pipeline peak around 3–4k tokens for brief/outline/script and ~12k for scene specs (which
 * embed every template's props schema) on 2-hour plans; these budgets leave headroom for long prompts,
 * style notes and references.
 */
export const STAGE_INPUT_TOKEN_ESTIMATE: Readonly<Record<LlmStage, number>> = Object.freeze({
  brief: 8_000,
  outline: 8_000,
  script: 8_000,
  storyboard: 12_000,
  shotList: 12_000,
  engineSelection: 12_000,
  sceneSpecs: 20_000,
});

export interface RunCostCeilingOptions {
  /** Provider-side cap on `max_tokens` (e.g. `ANTHROPIC_MAX_OUTPUT_TOKENS`); stage maxima above it are clamped. */
  maxOutputTokensCap?: number;
  /** Provider requests budgeted per stage call (default 1; repairs beyond it are not part of the ceiling). */
  attemptsPerCall?: number;
  /** Per-stage input-token budget overrides (default `STAGE_INPUT_TOKEN_ESTIMATE`). */
  inputTokens?: Partial<Readonly<Record<LlmStage, number>>>;
}

/** Number of provider calls (one attempt each) a full `planProject` run makes per LLM stage. */
export function stageCallCounts(plan: Pick<StructurePlan, 'chapterCount'>): Record<LlmStage, number> {
  const chapters = Math.max(0, Math.floor(plan.chapterCount));
  const counts = {} as Record<LlmStage, number>;
  for (const stage of LLM_STAGES) counts[stage] = stage === 'brief' || stage === 'outline' ? 1 : chapters;
  return counts;
}

/**
 * Deterministic upper estimate (USD) of what one full director run of `plan` can cost on `model`, computed
 * BEFORE the run: every stage call is assumed to produce its full `STAGE_MAX_OUTPUT_TOKENS` (clamped to the
 * provider cap) plus a generous input budget, priced at the higher of the input and cache-write rates.
 * Cache hits, shorter outputs and prompt-cache reads only make the real cost lower; repair attempts beyond
 * `attemptsPerCall` can exceed it (the caller should still meter live spend).
 *
 * Returns 0 for zero-priced models (the heuristic mock) and for models without known pricing (their actual
 * cost is also recorded as 0, see `estimateCostUsd`). The result is rounded up to whole micro-dollars.
 */
export function estimateRunCostCeilingUsd(
  plan: Pick<StructurePlan, 'chapterCount'>,
  model: string,
  pricing: Readonly<PricingTable> = DEFAULT_PRICING,
  options: RunCostCeilingOptions = {},
): number {
  const price = findPricing(model, pricing);
  if (price === null) return 0;
  const attempts = Math.max(1, Math.floor(options.attemptsPerCall ?? 1));
  const cap =
    options.maxOutputTokensCap !== undefined && Number.isFinite(options.maxOutputTokensCap)
      ? Math.max(1, Math.floor(options.maxOutputTokensCap))
      : Number.POSITIVE_INFINITY;
  const inputRate = Math.max(price.inputPerMTok, price.cacheWritePerMTok);
  const counts = stageCallCounts(plan);
  let micro = 0;
  for (const stage of LLM_STAGES) {
    const calls = counts[stage] * attempts;
    if (calls === 0) continue;
    const outputTokens = Math.min(STAGE_MAX_OUTPUT_TOKENS[stage], cap);
    const inputTokens = Math.max(0, options.inputTokens?.[stage] ?? STAGE_INPUT_TOKEN_ESTIMATE[stage]);
    // tokens × USD per million tokens = micro-dollars.
    micro += calls * (outputTokens * price.outputPerMTok + inputTokens * inputRate);
  }
  if (micro <= 0) return 0;
  // Tolerate float noise (e.g. 0.2 × 8000) before rounding up to whole micro-dollars.
  return Math.ceil(micro - 1e-6) / 1_000_000;
}
