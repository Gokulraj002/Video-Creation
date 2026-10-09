import {
  AIDirector,
  AnthropicProvider,
  DEFAULT_PRICING,
  DirectorError,
  estimateRunCostCeilingUsd,
  HeuristicMockProvider,
  PROMPT_VERSION,
  type AIProvider,
  type AnthropicEffort,
  type DirectorCache,
  type DirectorLogger,
  type PricingTable,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type StructurePlan,
} from '@vc/ai-director';
import { TokenUsageSchema, type AiProviderInfo, type TokenUsage } from '@vc/schema';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Logger } from '../lib/logger';
import { STUDIO_ENGINE_AVAILABILITY } from './engines';

/** Tokens consumed by one provider request (successful, or a failure that reports its usage). */
export interface ProviderCallUsage {
  model: string;
  usage: TokenUsage;
}

export interface CreateDirectorOptions {
  cache: DirectorCache | null;
  logger?: Logger;
  /** Extra fields bound into every director log line (e.g. the run id). */
  logBindings?: Record<string, unknown>;
  /** Called synchronously after every provider request with its token usage (live spend metering). */
  onProviderCall?: (call: ProviderCallUsage) => void;
}

/** Builds AI Directors for runs and describes the configured provider (for run rows and /v1/system/config). */
export interface DirectorFactory {
  readonly providerInfo: AiProviderInfo;
  readonly promptVersion: string;
  /** Pricing table the directors use (defaults merged with DIRECTOR_PRICING_JSON). */
  readonly pricing: Readonly<PricingTable>;
  /** Deterministic cost ceiling of a full run of `plan` with the configured provider/model (0 for the mock). */
  estimateRunCostCeilingUsd(plan: Pick<StructurePlan, 'chapterCount'>): number;
  createDirector(options: CreateDirectorOptions): AIDirector;
}

export interface DirectorFactoryOverrides {
  /** Inject a provider (tests use HeuristicMockProvider / ScriptedMockProvider). */
  provider?: AIProvider;
}

const ANTHROPIC_EFFORTS: Readonly<Record<AppConfig['ai']['anthropic']['effort'], AnthropicEffort>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** The provider selected by `AI_PROVIDER` (mock by default; Anthropic only with an API key). */
export function createProvider(config: AppConfig): AIProvider {
  if (config.ai.provider === 'anthropic') {
    const a = config.ai.anthropic;
    return new AnthropicProvider({
      ...(a.apiKey !== undefined ? { apiKey: a.apiKey } : {}),
      model: a.model,
      effort: ANTHROPIC_EFFORTS[a.effort],
      maxOutputTokens: a.maxOutputTokens,
      fallbacks: a.fallbacks,
      structuredOutput: a.structuredOutput,
    });
  }
  return new HeuristicMockProvider();
}

/** Adapts the app's pino-style logger `(obj, msg)` to the director's `(message, meta)` logger. */
export function toDirectorLogger(logger: Logger, bindings: Record<string, unknown> = {}): DirectorLogger {
  return {
    debug: (message, meta) => logger.debug({ ...bindings, ...meta }, message),
    info: (message, meta) => logger.info({ ...bindings, ...meta }, message),
    warn: (message, meta) => logger.warn({ ...bindings, ...meta }, message),
    error: (message, meta) => logger.error({ ...bindings, ...meta }, message),
  };
}

const ModelUsageListSchema = z.array(z.object({ model: z.string().min(1), usage: TokenUsageSchema }));

/** Billed usage carried by a provider error (refused / truncated responses), per model when known. */
function errorUsage(err: unknown, fallbackModel: string): ProviderCallUsage[] {
  if (!(err instanceof DirectorError)) return [];
  if ('usageByModel' in err) {
    const parts = ModelUsageListSchema.safeParse(err.usageByModel);
    if (parts.success && parts.data.length > 0) return parts.data;
  }
  if (!('tokenUsage' in err)) return [];
  const usage = TokenUsageSchema.safeParse(err.tokenUsage);
  if (!usage.success) return [];
  const model = 'model' in err && typeof err.model === 'string' && err.model.length > 0 ? err.model : fallbackModel;
  return [{ model, usage: usage.data }];
}

/** Delegating provider that reports the usage of every request (used to meter a run's spend while it runs). */
export class MeteredProvider implements AIProvider {
  constructor(
    private readonly inner: AIProvider,
    private readonly onCall: (call: ProviderCallUsage) => void,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  get mode(): AIProvider['mode'] {
    return this.inner.mode;
  }

  /** Forwarded: it is part of every director cache key. */
  get configFingerprint(): string | undefined {
    return this.inner.configFingerprint;
  }

  async generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult> {
    let result: StructuredGenerationResult;
    try {
      result = await this.inner.generateStructured(req);
    } catch (err) {
      for (const part of errorUsage(err, this.inner.model)) this.onCall(part);
      throw err;
    }
    const parts = result.usageByModel;
    if (parts !== undefined && parts.length > 0) {
      // Server-side fallbacks: every hop is billed at its own model's price.
      for (const part of parts) this.onCall({ model: part.model, usage: part.usage });
    } else {
      this.onCall({ model: result.model, usage: result.usage });
    }
    return result;
  }
}

export function createDirectorFactory(config: AppConfig, overrides: DirectorFactoryOverrides = {}): DirectorFactory {
  const provider = overrides.provider ?? createProvider(config);
  const pricing: Readonly<PricingTable> = { ...DEFAULT_PRICING, ...(config.director.pricingOverrides ?? {}) };
  const configured =
    provider.mode === 'mock' || (config.ai.provider === 'anthropic' && config.ai.anthropic.apiKey !== undefined);
  // The Anthropic provider clamps every stage's max_tokens to ANTHROPIC_MAX_OUTPUT_TOKENS.
  const maxOutputTokensCap =
    overrides.provider === undefined && config.ai.provider === 'anthropic' ? config.ai.anthropic.maxOutputTokens : undefined;
  return {
    providerInfo: { name: provider.name, model: provider.model, mode: provider.mode, configured },
    promptVersion: PROMPT_VERSION,
    pricing,
    estimateRunCostCeilingUsd(plan) {
      return estimateRunCostCeilingUsd(plan, provider.model, pricing, {
        ...(maxOutputTokensCap !== undefined ? { maxOutputTokensCap } : {}),
      });
    },
    createDirector({ cache, logger, logBindings, onProviderCall }) {
      return new AIDirector({
        provider: onProviderCall !== undefined ? new MeteredProvider(provider, onProviderCall) : provider,
        ...(cache !== null ? { cache } : {}),
        pricing,
        limits: config.limits,
        maxRepairAttempts: config.director.maxRepairAttempts,
        engineAvailability: { ...STUDIO_ENGINE_AVAILABILITY },
        promptVersion: PROMPT_VERSION,
        ...(logger !== undefined ? { logger: toDirectorLogger(logger, logBindings) } : {}),
      });
    },
  };
}
