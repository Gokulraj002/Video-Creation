import {
  AIDirector,
  AnthropicProvider,
  DEFAULT_PRICING,
  HeuristicMockProvider,
  PROMPT_VERSION,
  type AIProvider,
  type DirectorCache,
} from '@vc/ai-director';
import type { AiProviderInfo } from '@vc/schema';
import type { AppConfig } from '../config';
import type { Logger } from '../lib/logger';
import { STUDIO_ENGINE_AVAILABILITY } from './engines';

export interface CreateDirectorOptions {
  cache: DirectorCache | null;
  logger?: Logger;
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

/** The provider selected by `AI_PROVIDER` (mock by default; Anthropic only with an API key). */
export function createProvider(config: AppConfig): AIProvider {
  if (config.ai.provider === 'anthropic') {
    const a = config.ai.anthropic;
    return new AnthropicProvider({
      apiKey: a.apiKey,
      model: a.model,
      effort: a.effort,
      maxOutputTokens: a.maxOutputTokens,
      fallbacks: a.fallbacks,
      structuredOutput: a.structuredOutput,
    });
  }
  return new HeuristicMockProvider();
}

export function createDirectorFactory(config: AppConfig, overrides: DirectorFactoryOverrides = {}): DirectorFactory {
  const provider = overrides.provider ?? createProvider(config);
  const pricing = { ...DEFAULT_PRICING, ...(config.director.pricingOverrides ?? {}) };
  const configured =
    provider.mode === 'mock' || (config.ai.provider === 'anthropic' && config.ai.anthropic.apiKey !== undefined);
  return {
    providerInfo: { name: provider.name, model: provider.model, mode: provider.mode, configured },
    promptVersion: PROMPT_VERSION,
    createDirector({ cache, logger }) {
      return new AIDirector({
        provider,
        ...(cache !== null ? { cache } : {}),
        pricing,
        limits: config.limits,
        maxRepairAttempts: config.director.maxRepairAttempts,
        engineAvailability: { ...STUDIO_ENGINE_AVAILABILITY },
        promptVersion: PROMPT_VERSION,
        ...(logger !== undefined ? { logger } : {}),
      });
    },
  };
}
