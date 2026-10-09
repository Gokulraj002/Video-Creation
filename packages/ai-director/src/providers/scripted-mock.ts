import type { DirectorStage } from '@vc/schema';
import { estimateTokens, type AIProvider, type StructuredGenerationRequest, type StructuredGenerationResult } from '../provider';

export interface ScriptedCall {
  stage: DirectorStage;
  chunk: string | null;
  prompt: string;
  system: string;
  input: unknown;
  schemaName: string;
}

export type ScriptedHandler = (req: StructuredGenerationRequest<unknown>, callIndex: number) => unknown | Promise<unknown>;

export interface ScriptedMockOptions {
  name?: string;
  model?: string;
  /** Cache fingerprint (default `scripted:<name>:<model>`). */
  configFingerprint?: string;
}

/**
 * Test provider: every call is answered by `handler(req, callIndex)` (return any output, throw a
 * `DirectorError` to simulate refusals/outages, or await to simulate latency). Records `calls`.
 */
export class ScriptedMockProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  readonly mode = 'mock' as const;
  readonly configFingerprint: string;
  readonly calls: ScriptedCall[] = [];

  constructor(
    private readonly handler: ScriptedHandler,
    options: ScriptedMockOptions = {},
  ) {
    this.name = options.name ?? 'scripted-mock';
    this.model = options.model ?? 'scripted-mock-v1';
    this.configFingerprint = options.configFingerprint ?? `scripted:${this.name}:${this.model}`;
  }

  async generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult> {
    const started = Date.now();
    const callIndex = this.calls.length;
    this.calls.push({
      stage: req.stage,
      chunk: req.chunk,
      prompt: req.prompt,
      system: req.system,
      input: req.input,
      schemaName: req.schemaName,
    });
    const output = await this.handler(req as StructuredGenerationRequest<unknown>, callIndex);
    return {
      output,
      usage: {
        inputTokens: estimateTokens(req.system) + estimateTokens(req.prompt),
        outputTokens: estimateTokens(JSON.stringify(output) ?? ''),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      provider: this.name,
      model: this.model,
      stopReason: 'end_turn',
      latencyMs: Date.now() - started,
    };
  }
}
