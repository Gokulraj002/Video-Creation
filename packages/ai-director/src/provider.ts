import type { z } from 'zod';
import type { DirectorStage, TokenUsage } from '@vc/schema';

/** One structured-output request made by the director (one stage, optionally one chunk of it). */
export interface StructuredGenerationRequest<T> {
  stage: DirectorStage;
  /** Chunk = chapter id for chunked stages (scene id when regenerating a single scene); null otherwise. */
  chunk: string | null;
  /** Stable, cacheable stage system prompt. */
  system: string;
  /** Rendered user content (data wrapped in XML-ish tags). */
  prompt: string;
  /** Structured stage input (mocks build their output from this). */
  input: unknown;
  /** Output schema (LLM-safe). */
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface StructuredGenerationResult {
  /** NOT yet validated — the director validates with Zod + semantic checks. */
  output: unknown;
  usage: TokenUsage;
  provider: string;
  /** Model that actually served the request. */
  model: string;
  stopReason: string;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  readonly mode: 'mock' | 'live';
  generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult>;
}

/** Rough token estimate used by mock providers (≈ 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
