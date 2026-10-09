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

/** Token usage carried by a provider error (e.g. a truncated response), if it reports any. */
function errorTokenUsage(err: unknown): TokenUsage | null {
  if (!(err instanceof DirectorError) || !('tokenUsage' in err)) return null;
  const parsed = TokenUsageSchema.safeParse(err.tokenUsage);
  return parsed.success ? parsed.data : null;
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

  async generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult> {
    let result: StructuredGenerationResult;
    try {
      result = await this.inner.generateStructured(req);
    } catch (err) {
      const usage = errorTokenUsage(err);
      if (usage !== null) this.onCall({ model: this.inner.model, usage });
      throw err;
    }
    this.onCall({ model: result.model, usage: result.usage });
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
