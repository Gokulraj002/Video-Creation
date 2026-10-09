import type { DirectorStage, StageUsage, TokenUsage, UsageReport } from '@vc/schema';
import { DEFAULT_PRICING, estimateCostUsd, type PricingTable } from './pricing';

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

export interface StageCallRecord {
  stage: DirectorStage;
  chunk: string | null;
  provider: string;
  model: string;
  attempts: number;
  cached: boolean;
  usage: TokenUsage;
  latencyMs: number;
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
    const usage = call.cached ? { ...ZERO_USAGE } : { ...call.usage };
    const { costUsd, pricingKnown } = call.cached
      ? { costUsd: 0, pricingKnown: true }
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
