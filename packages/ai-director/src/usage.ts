import type { DirectorStage, StageUsage, TokenUsage, UsageReport } from '@vc/schema';
import { DEFAULT_PRICING, estimateCostUsd, type CostEstimate, type PricingTable } from './pricing';

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Tokens consumed by one model (one attempt, or one server-side fallback hop of an attempt). */
export interface ModelTokenUsage {
  model: string;
  usage: TokenUsage;
}

export interface StageCallRecord {
  stage: DirectorStage;
  chunk: string | null;
  provider: string;
  /** Model that served the last attempt (reported on the stage). */
  model: string;
  attempts: number;
  cached: boolean;
  usage: TokenUsage;
  /**
   * Optional per-model breakdown (attempts and server-side fallback hops may be served by different models). When
   * non-empty it is authoritative: `usage` is its sum and the cost prices every entry by its own model.
   */
  usageByModel?: readonly ModelTokenUsage[];
  latencyMs: number;
}

/** Sums a per-model usage breakdown. */
export function sumModelUsage(parts: readonly ModelTokenUsage[]): TokenUsage {
  return parts.reduce<TokenUsage>((acc, p) => addUsage(acc, p.usage), { ...ZERO_USAGE });
}

/** Cost of a per-model usage breakdown: every entry priced by its own model; `pricingKnown` only if all are known. */
export function estimateCostByModel(parts: readonly ModelTokenUsage[], pricing: Readonly<PricingTable> = DEFAULT_PRICING): CostEstimate {
  let costUsd = 0;
  let pricingKnown = true;
  for (const part of parts) {
    const cost = estimateCostUsd(part.model, part.usage, pricing);
    costUsd += cost.costUsd;
    if (!cost.pricingKnown) pricingKnown = false;
  }
  return { costUsd, pricingKnown };
}

/**
 * Summarizes stage usage. `totals.calls` counts provider requests actually made (sum of attempts of
 * non-cached stages); `totals.cachedCalls` counts stages served from the director cache.
 */
export function summarizeUsage(stages: readonly StageUsage[]): UsageReport {
  let totals = { ...ZERO_USAGE };
  let cost = 0;
  let calls = 0;
  let cachedCalls = 0;
  for (const s of stages) {
    totals = addUsage(totals, s.usage);
    cost += s.estimatedCostUsd;
    if (s.cached) cachedCalls += 1;
    else calls += s.attempts;
  }
  return {
    stages: stages.map((s) => ({ ...s, usage: { ...s.usage } })),
    totals: { ...totals, estimatedCostUsd: cost, calls, cachedCalls },
  };
}

/** Accumulates per-stage usage and cost for one director run. */
export class UsageTracker {
  private readonly entries: StageUsage[] = [];

  constructor(private readonly pricing: Readonly<PricingTable> = DEFAULT_PRICING) {}

  /** Records one stage call; cached calls are recorded with zero tokens and zero cost. */
  record(call: StageCallRecord): StageUsage {
    const parts = !call.cached && call.usageByModel && call.usageByModel.length > 0 ? call.usageByModel : null;
    const usage = call.cached ? { ...ZERO_USAGE } : parts ? sumModelUsage(parts) : { ...call.usage };
    const { costUsd, pricingKnown } = call.cached
      ? { costUsd: 0, pricingKnown: true }
      : parts
        ? estimateCostByModel(parts, this.pricing)
        : estimateCostUsd(call.model, usage, this.pricing);
    const entry: StageUsage = {
      stage: call.stage,
      chunk: call.chunk,
      provider: call.provider,
      model: call.model,
      attempts: Math.max(1, Math.floor(call.attempts)),
      cached: call.cached,
      usage,
      estimatedCostUsd: costUsd,
      pricingKnown,
      latencyMs: Math.max(0, call.latencyMs),
    };
    this.entries.push(entry);
    return entry;
  }

  get stages(): readonly StageUsage[] {
    return this.entries;
  }

  report(): UsageReport {
    return summarizeUsage(this.entries);
  }
}
