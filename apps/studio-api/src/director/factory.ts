import {
  AIDirector,
  AnthropicProvider,
  DEFAULT_PRICING,
  HeuristicMockProvider,
  PROMPT_VERSION,
  type AIProvider,
  type AnthropicEffort,
  type DirectorCache,
  type DirectorLogger,
} from '@vc/ai-director';
import type { AiProviderInfo } from '@vc/schema';
import type { AppConfig } from '../config';
import type { Logger } from '../lib/logger';
import { STUDIO_ENGINE_AVAILABILITY } from './engines';

export interface CreateDirectorOptions {
  cache: DirectorCache | null;
  logger?: Logger;
  /** Extra fields bound into every director log line (e.g. the run id). */
  logBindings?: Record<string, unknown>;
}

/** Builds AI Directors for runs and describes the configured provider (for run rows and /v1/system/config). */
export interface DirectorFactory {
  readonly providerInfo: AiProviderInfo;
  readonly promptVersion: string;
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

export function createDirectorFactory(config: AppConfig, overrides: DirectorFactoryOverrides = {}): DirectorFactory {
  const provider = overrides.provider ?? createProvider(config);
  const pricing = { ...DEFAULT_PRICING, ...(config.director.pricingOverrides ?? {}) };
  const configured =
    provider.mode === 'mock' || (config.ai.provider === 'anthropic' && config.ai.anthropic.apiKey !== undefined);
  return {
    providerInfo: { name: provider.name, model: provider.model, mode: provider.mode, configured },
    promptVersion: PROMPT_VERSION,
    createDirector({ cache, logger, logBindings }) {
      return new AIDirector({
        provider,
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
