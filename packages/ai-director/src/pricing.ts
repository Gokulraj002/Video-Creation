import { z } from 'zod';
import type { TokenUsage } from '@vc/schema';

export const ModelPricingSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0),
  /** 5-minute cache write price. */
  cacheWritePerMTok: z.number().min(0),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const PricingTableSchema = z.record(z.string().min(1), ModelPricingSchema);
export type PricingTable = Record<string, ModelPricing>;

/** USD per million tokens. Overridable via the director/provider constructor (apps pass env JSON). */
export const DEFAULT_PRICING: Readonly<PricingTable> = Object.freeze({
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  'mock-director-v1': { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
});

const DATE_SUFFIX = /-\d{8}$/;

/** Looks up a model's pricing (exact id, or the id without a `-YYYYMMDD` snapshot suffix). */
export function findPricing(model: string, pricing: Readonly<PricingTable> = DEFAULT_PRICING): ModelPricing | null {
  const exact = pricing[model];
  if (exact) return exact;
  if (DATE_SUFFIX.test(model)) {
    const base = pricing[model.replace(DATE_SUFFIX, '')];
    if (base) return base;
  }
  return null;
}

export interface CostEstimate {
  costUsd: number;
  pricingKnown: boolean;
}

/** Estimated cost in USD. Unknown models cost 0 with `pricingKnown: false`. */
export function estimateCostUsd(model: string, usage: TokenUsage, pricing: Readonly<PricingTable> = DEFAULT_PRICING): CostEstimate {
  const p = findPricing(model, pricing);
  if (!p) return { costUsd: 0, pricingKnown: false };
  const micro =
    usage.inputTokens * p.inputPerMTok +
    usage.outputTokens * p.outputPerMTok +
    usage.cacheReadTokens * p.cacheReadPerMTok +
    usage.cacheWriteTokens * p.cacheWritePerMTok;
  return { costUsd: micro / 1_000_000, pricingKnown: true };
}

/** Parses a pricing override (e.g. from an env var holding JSON) and merges it over the defaults. */
export function parsePricingOverrides(json: string | undefined | null, base: Readonly<PricingTable> = DEFAULT_PRICING): PricingTable {
  if (json === undefined || json === null || json.trim() === '') return { ...base };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new TypeError(`Invalid pricing JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = PricingTableSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(`Invalid pricing table: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { ...base, ...parsed.data };
}
