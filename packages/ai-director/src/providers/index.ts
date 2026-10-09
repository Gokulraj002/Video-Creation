import type { AIProvider } from '../provider';
import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic';
import { HeuristicMockProvider } from './heuristic-mock';

export * from './anthropic';
export * from './heuristic-mock';
export * from './scripted-mock';

export type AIProviderConfig = ({ kind: 'mock' }) | ({ kind: 'anthropic' } & AnthropicProviderOptions);

/** Builds a provider from app config (`AI_PROVIDER=mock` → heuristic mock, `anthropic` → Claude). */
export function createAIProvider(config: AIProviderConfig): AIProvider {
  if (config.kind === 'anthropic') {
    const { kind: _kind, ...options } = config;
    void _kind;
    return new AnthropicProvider(options);
  }
  return new HeuristicMockProvider();
}
