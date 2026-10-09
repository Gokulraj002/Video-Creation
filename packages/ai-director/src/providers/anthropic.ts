import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '@vc/schema';
import {
  CancelledError,
  DirectorError,
  ProviderConfigError,
  ProviderRefusalError,
  ProviderRequestError,
  ProviderTruncatedError,
  ProviderUnavailableError,
} from '../errors';
import type { AIProvider, StructuredGenerationRequest, StructuredGenerationResult } from '../provider';
import { toStructuredOutputSchema } from '../structured-output';
import { isRecord, parseJsonText } from '../util/json';

/** Minimal structural client type so tests can inject a fake (the real one is `new Anthropic(...)`). */
export interface AnthropicLikeClient {
  beta: {
    messages: {
      create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
    };
  };
}

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Default `claude-opus-5-5`. */
  model?: string;
  /** Default `medium` (set explicitly; Opus 5.5 thinking cannot be disabled — effort is the control). */
  effort?: AnthropicEffort;
  /** Upper bound for `max_tokens` (non-streaming requests stay ≤ 16 000). Default 16 000. */
  maxOutputTokens?: number;
  /** Server-side refusal fallbacks (`fallbacks: "default"`). Default `default`. */
  fallbacks?: 'default' | 'off';
  /** `json_schema` = structured outputs (default); `prompt` = schema embedded in the prompt. */
  structuredOutput?: 'json_schema' | 'prompt';
  /** Default 600 000 ms. */
  timeoutMs?: number;
  /** SDK retries for 408/409/429/5xx/connection errors. Default 2. */
  maxRetries?: number;
  client?: AnthropicLikeClient;
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_NON_STREAMING_TOKENS = 16_000;

const SCHEMA_ERROR_HINT = /schema|output_config|format/i;

interface ParsedResponse {
  model: string;
  stopReason: string;
  text: string;
  usage: TokenUsage;
  stopDetails: { category: string | null; explanation: string | null } | null;
}

function intOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Defensive narrowing of the Messages API response. */
export function parseAnthropicResponse(response: unknown, fallbackModel: string): ParsedResponse {
  if (!isRecord(response)) throw new ProviderRequestError('Anthropic returned a non-object response');
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('');
  const usage = isRecord(response.usage) ? response.usage : {};
  const details = isRecord(response.stop_details) ? response.stop_details : null;
  return {
    model: typeof response.model === 'string' && response.model.length > 0 ? response.model : fallbackModel,
    stopReason: typeof response.stop_reason === 'string' ? response.stop_reason : 'unknown',
    text,
    usage: {
      inputTokens: intOr0(usage.input_tokens),
      outputTokens: intOr0(usage.output_tokens),
      cacheReadTokens: intOr0(usage.cache_read_input_tokens),
      cacheWriteTokens: intOr0(usage.cache_creation_input_tokens),
    },
    stopDetails: details ? { category: stringOrNull(details.category), explanation: stringOrNull(details.explanation) } : null,
  };
}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    let body = '';
    try {
      body = JSON.stringify(err.error ?? null);
    } catch {
      body = '';
    }
    return `${err.message} ${body}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Claude provider (`mode: 'live'`). Uses structured outputs (`output_config.format` json_schema), explicit
 * `output_config.effort`, a cached system prompt and server-side refusal fallbacks. Never sends `thinking`,
 * `temperature`, `top_p`, `top_k` or an assistant prefill.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly mode = 'live' as const;
  readonly effort: AnthropicEffort;
  readonly maxOutputTokens: number;
  readonly fallbacks: 'default' | 'off';
  readonly structuredOutput: 'json_schema' | 'prompt';
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly apiKey: string | undefined;
  private client: AnthropicLikeClient | null;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.effort = options.effort ?? 'medium';
    this.maxOutputTokens = Math.min(MAX_NON_STREAMING_TOKENS, Math.max(1, Math.floor(options.maxOutputTokens ?? MAX_NON_STREAMING_TOKENS)));
    this.fallbacks = options.fallbacks ?? 'default';
    this.structuredOutput = options.structuredOutput ?? 'json_schema';
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.apiKey = options.apiKey;
    this.client = options.client ?? null;
  }

  private getClient(): AnthropicLikeClient {
    if (this.client) return this.client;
    let sdk: Anthropic;
    try {
      sdk = new Anthropic({
        ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
        timeout: this.timeoutMs,
        maxRetries: this.maxRetries,
      });
    } catch (err) {
      throw new ProviderConfigError(`Anthropic client is not configured: ${errorText(err)}`, { cause: err });
    }
    // The installed SDK types may lag behind the API (fallbacks, output_config.format); params are built as a
    // plain object and passed through the structural interface.
    const create = sdk.beta.messages.create.bind(sdk.beta.messages) as unknown as AnthropicLikeClient['beta']['messages']['create'];
    this.client = { beta: { messages: { create } } };
    return this.client;
  }

  /** Request body for one call (exported for tests and debugging). */
  buildParams<T>(req: StructuredGenerationRequest<T>, mode: 'json_schema' | 'prompt'): Record<string, unknown> {
    const maxTokens = Math.max(1, Math.min(this.maxOutputTokens, Math.floor(req.maxOutputTokens)));
    const schema = toStructuredOutputSchema(req.schema);
    const userText =
      mode === 'json_schema'
        ? req.prompt
        : `${req.prompt}\n\n<output_schema name="${req.schemaName}">\n${JSON.stringify(schema)}\n</output_schema>\n\n` +
          'Respond with ONLY one JSON object that validates against <output_schema>: no prose, no markdown fences.';
    const outputConfig: Record<string, unknown> = { effort: this.effort };
    if (mode === 'json_schema') outputConfig.format = { type: 'json_schema', schema };
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      output_config: outputConfig,
    };
    if (this.fallbacks === 'default') {
      params.betas = [SERVER_SIDE_FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    return params;
  }

  async generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult> {
    if (req.signal?.aborted) throw new CancelledError();
    try {
      return await this.request(req, this.structuredOutput);
    } catch (err) {
      if (
        this.structuredOutput === 'json_schema' &&
        err instanceof Anthropic.BadRequestError &&
        SCHEMA_ERROR_HINT.test(errorText(err))
      ) {
        // The schema (or structured outputs) was rejected: retry ONCE with the schema embedded in the prompt.
        try {
          return await this.request(req, 'prompt');
        } catch (retryErr) {
          throw this.mapError(retryErr, req);
        }
      }
      throw this.mapError(err, req);
    }
  }

  private async request<T>(req: StructuredGenerationRequest<T>, mode: 'json_schema' | 'prompt'): Promise<StructuredGenerationResult> {
    const client = this.getClient();
    const params = this.buildParams(req, mode);
    const started = Date.now();
    const response = await client.beta.messages.create(params, req.signal ? { signal: req.signal } : undefined);
    const latencyMs = Date.now() - started;
    const parsed = parseAnthropicResponse(response, this.model);

    if (parsed.stopReason === 'refusal') {
      const category = parsed.stopDetails?.category ?? null;
      throw new ProviderRefusalError(
        `The model declined the ${req.stage} request${category ? ` (category: ${category})` : ''}`,
        { category, explanation: parsed.stopDetails?.explanation ?? null },
        { stage: req.stage, chunk: req.chunk },
      );
    }
    if (parsed.stopReason === 'max_tokens') {
      throw new ProviderTruncatedError(
        `The ${req.stage} response was truncated at max_tokens (${String(params.max_tokens)})`,
        { usage: parsed.usage, partialOutput: parsed.text },
        { stage: req.stage, chunk: req.chunk },
      );
    }
    const json = parseJsonText(parsed.text);
    return {
      // Unparseable text is passed through as a string; the director reports it as a validation issue.
      output: json.ok ? json.value : parsed.text,
      usage: parsed.usage,
      provider: this.name,
      model: parsed.model,
      stopReason: parsed.stopReason,
      latencyMs,
    };
  }

  private mapError<T>(err: unknown, req: StructuredGenerationRequest<T>): DirectorError {
    const where = { stage: req.stage, chunk: req.chunk, cause: err };
    if (err instanceof DirectorError) return err;
    if (err instanceof Anthropic.APIUserAbortError || req.signal?.aborted) return new CancelledError(undefined, where);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return new ProviderConfigError(`Anthropic rejected the credentials: ${err.message}`, where);
    }
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    ) {
      return new ProviderUnavailableError(`Anthropic is unavailable: ${err.message}`, where);
    }
    if (err instanceof Anthropic.APIError) {
      const status = typeof err.status === 'number' ? err.status : null;
      if (status !== null && (status === 529 || status >= 500)) {
        return new ProviderUnavailableError(`Anthropic is unavailable (${status}): ${err.message}`, where);
      }
      return new ProviderRequestError(`Anthropic rejected the request${status ? ` (${status})` : ''}: ${err.message}`, where);
    }
    return new ProviderRequestError(`Anthropic request failed: ${errorText(err)}`, where);
  }
}
