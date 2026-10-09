import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { CreativeBriefSchema, type CreativeBrief } from '@vc/schema';
import {
  AIDirector,
  AnthropicProvider,
  DirectorError,
  ProviderRefusalError,
  ProviderTruncatedError,
  SYSTEM_PROMPTS,
  type AnthropicLikeClient,
  type StructuredGenerationRequest,
} from '../src';
import { makeRequest } from './helpers';

type Responder = (params: Record<string, unknown>, callIndex: number) => unknown;

class FakeClient implements AnthropicLikeClient {
  readonly requests: { params: Record<string, unknown>; signal: AbortSignal | undefined }[] = [];
  readonly beta: AnthropicLikeClient['beta'];

  constructor(responder: Responder) {
    this.beta = {
      messages: {
        create: async (params, options) => {
          const index = this.requests.length;
          this.requests.push({ params, signal: options?.signal });
          return responder(params, index);
        },
      },
    };
  }
}

const brief: CreativeBrief = {
  title: 'Aurora',
  logline: 'A bottle that reminds you to drink.',
  objective: 'Sell the bottle.',
  targetAudience: 'Busy professionals',
  tone: ['upbeat'],
  genre: 'promo',
  visualStyle: { description: 'Bright', palette: ['#000000', '#FFFFFF'], typography: 'Sans', motionLanguage: 'Snappy' },
  keyMessages: ['Stay hydrated'],
  callToAction: 'Order now',
  referenceInfluence: null,
  brandConsistencyNotes: '',
};

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    ...extra,
  };
}

function req(signal?: AbortSignal): StructuredGenerationRequest<CreativeBrief> {
  return {
    stage: 'brief',
    chunk: null,
    system: SYSTEM_PROMPTS.brief,
    prompt: '<user_request>{"title":"Aurora"}</user_request>',
    input: {},
    schema: CreativeBriefSchema,
    schemaName: 'creative_brief',
    maxOutputTokens: 8000,
    ...(signal ? { signal } : {}),
  };
}

function apiError<T extends new (status: never, error: object, message: string, headers: Headers) => Error>(Cls: T, status: number, msg: string): Error {
  return new Cls(status as never, { type: 'error', error: { type: 'invalid_request_error', message: msg } }, msg, new Headers());
}

async function rejection(promise: Promise<unknown>): Promise<DirectorError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DirectorError);
  return err as DirectorError;
}

describe('AnthropicProvider request shape', () => {
  it('uses claude-opus-5-5, structured outputs, explicit effort, cached system prompt and refusal fallbacks', async () => {
    const client = new FakeClient(() => message(JSON.stringify(brief)));
    const provider = new AnthropicProvider({ client });
    expect(provider.mode).toBe('live');
    expect(provider.model).toBe('claude-opus-5-5');
    const controller = new AbortController();
    await provider.generateStructured(req(controller.signal));

    const { params, signal } = client.requests[0] ?? { params: {}, signal: undefined };
    expect(signal).toBe(controller.signal);
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.max_tokens).toBe(8000);
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'stream']) {
      expect(params, forbidden).not.toHaveProperty(forbidden);
    }
    expect(params.system).toEqual([{ type: 'text', text: SYSTEM_PROMPTS.brief, cache_control: { type: 'ephemeral' } }]);
    const messages = params.messages as { role: string; content: { type: string; text: string }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content[0]?.text).toBe('<user_request>{"title":"Aurora"}</user_request>');

    const outputConfig = params.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(outputConfig.effort).toBe('medium');
    expect(outputConfig.format.type).toBe('json_schema');
    expect(outputConfig.format.schema.type).toBe('object');
    expect(outputConfig.format.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(outputConfig.format.schema)).not.toMatch(/"(\$schema|minLength|maxLength|minItems|maxItems|pattern)"/);
  });

  it('honours options: effort, max tokens cap (≤ 16k) and fallbacks off', async () => {
    const client = new FakeClient(() => message(JSON.stringify(brief)));
    const provider = new AnthropicProvider({ client, effort: 'high', maxOutputTokens: 50_000, fallbacks: 'off', model: 'claude-sonnet-5-5' });
    await provider.generateStructured({ ...req(), maxOutputTokens: 40_000 });
    const params = client.requests[0]?.params ?? {};
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.max_tokens).toBe(16_000);
    expect((params.output_config as { effort: string }).effort).toBe('high');
    expect(params).not.toHaveProperty('betas');
    expect(params).not.toHaveProperty('fallbacks');
  });

  it('prompt mode embeds the schema in the prompt and sends no format', async () => {
    const client = new FakeClient(() => message(JSON.stringify(brief)));
    await new AnthropicProvider({ client, structuredOutput: 'prompt' }).generateStructured(req());
    const params = client.requests[0]?.params ?? {};
    expect(params.output_config).toEqual({ effort: 'medium' });
    const text = (params.messages as { content: { text: string }[] }[])[0]?.content[0]?.text ?? '';
    expect(text).toContain('<output_schema name="creative_brief">');
    expect(text).toContain('"additionalProperties":false');
  });
});

describe('AnthropicProvider response handling', () => {
  it('concatenates text blocks, strips fences, parses JSON and maps usage + served model', async () => {
    const json = JSON.stringify(brief);
    const client = new FakeClient(() => ({
      ...message(''),
      model: 'claude-opus-5-5-20261001',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: '```json\n' + json.slice(0, 20) },
        { type: 'text', text: json.slice(20) + '\n```' },
      ],
    }));
    const result = await new AnthropicProvider({ client }).generateStructured(req());
    expect(result.output).toEqual(brief);
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 50 });
    expect(result.model).toBe('claude-opus-5-5-20261001');
    expect(result.provider).toBe('anthropic');
    expect(result.stopReason).toBe('end_turn');
  });

  it('defaults missing cache usage fields to 0 and passes unparseable text through', async () => {
    const client = new FakeClient(() => ({ ...message('not json'), usage: { input_tokens: 5, output_tokens: 2 } }));
    const result = await new AnthropicProvider({ client }).generateStructured(req());
    expect(result.output).toBe('not json');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('maps stop_reason "refusal" to a non-retryable ProviderRefusalError with the category', async () => {
    const client = new FakeClient(() =>
      message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'policy' } }),
    );
    const err = await rejection(new AnthropicProvider({ client }).generateStructured(req()));
    expect(err).toBeInstanceOf(ProviderRefusalError);
    expect(err.code).toBe('PROVIDER_REFUSAL');
    expect(err.retryable).toBe(false);
    expect((err as ProviderRefusalError).category).toBe('cyber');
    expect(client.requests).toHaveLength(1);
  });

  it('maps stop_reason "max_tokens" to ProviderTruncatedError with usage', async () => {
    const client = new FakeClient(() => message('{"title": "Aur', { stop_reason: 'max_tokens' }));
    const err = await rejection(new AnthropicProvider({ client }).generateStructured(req()));
    expect(err).toBeInstanceOf(ProviderTruncatedError);
    expect(err.code).toBe('PROVIDER_TRUNCATED');
    expect((err as ProviderTruncatedError).tokenUsage?.outputTokens).toBe(340);
    expect((err as ProviderTruncatedError).partialOutput).toBe('{"title": "Aur');
  });

  it('retries ONCE in prompt mode when the JSON schema is rejected (BadRequest)', async () => {
    const client = new FakeClient((_params, i) => {
      if (i === 0) throw apiError(Anthropic.BadRequestError, 400, 'output_config.format.schema: unsupported keyword');
      return message(JSON.stringify(brief));
    });
    const result = await new AnthropicProvider({ client }).generateStructured(req());
    expect(result.output).toEqual(brief);
    expect(client.requests).toHaveLength(2);
    const retry = client.requests[1]?.params ?? {};
    expect(retry.output_config).toEqual({ effort: 'medium' });
    expect(retry.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(JSON.stringify(retry.messages)).toContain('output_schema');
  });

  it('does not retry unrelated bad requests', async () => {
    const client = new FakeClient(() => {
      throw apiError(Anthropic.BadRequestError, 400, 'messages: text content blocks must be non-empty');
    });
    const err = await rejection(new AnthropicProvider({ client }).generateStructured(req()));
    expect(err.code).toBe('PROVIDER_REQUEST');
    expect(client.requests).toHaveLength(1);
  });

  it('maps SDK error classes onto director error codes', async () => {
    const cases: [() => Error, string, boolean][] = [
      [() => apiError(Anthropic.RateLimitError, 429, 'rate limited'), 'PROVIDER_UNAVAILABLE', true],
      [() => apiError(Anthropic.InternalServerError, 529, 'overloaded'), 'PROVIDER_UNAVAILABLE', true],
      [() => new Anthropic.APIConnectionError({ message: 'socket hang up' }), 'PROVIDER_UNAVAILABLE', true],
      [() => new Anthropic.APIConnectionTimeoutError(), 'PROVIDER_UNAVAILABLE', true],
      [() => apiError(Anthropic.AuthenticationError, 401, 'invalid x-api-key'), 'PROVIDER_CONFIG', false],
      [() => apiError(Anthropic.PermissionDeniedError, 403, 'forbidden'), 'PROVIDER_CONFIG', false],
      [() => apiError(Anthropic.NotFoundError, 404, 'model not found'), 'PROVIDER_REQUEST', false],
    ];
    for (const [make, code, retryable] of cases) {
      const client = new FakeClient(() => {
        throw make();
      });
      const err = await rejection(new AnthropicProvider({ client }).generateStructured(req()));
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
    }
  });

  it('reports cancellation when the signal is aborted', async () => {
    const controller = new AbortController();
    const client = new FakeClient(() => {
      controller.abort();
      throw new Anthropic.APIUserAbortError();
    });
    const err = await rejection(new AnthropicProvider({ client }).generateStructured(req(controller.signal)));
    expect(err.code).toBe('CANCELLED');
  });

  it('rejects non-object responses', async () => {
    const err = await rejection(new AnthropicProvider({ client: new FakeClient(() => 'nope') }).generateStructured(req()));
    expect(err.code).toBe('PROVIDER_REQUEST');
  });
});

describe('AnthropicProvider inside the director', () => {
  it('validates live output, bills real usage and surfaces refusals with partial usage', async () => {
    const client = new FakeClient((params) => {
      const system = (params.system as { text: string }[])[0]?.text ?? '';
      if (system === SYSTEM_PROMPTS.brief) return message(JSON.stringify(brief));
      return message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } });
    });
    const director = new AIDirector({ provider: new AnthropicProvider({ client }) });
    const err = await rejection(director.planProject({ request: makeRequest() }));
    expect(err.code).toBe('PROVIDER_REFUSAL');
    expect(err.stage).toBe('outline');
    expect(client.requests).toHaveLength(2);
    const briefUsage = err.usage?.stages[0];
    expect(briefUsage).toMatchObject({ stage: 'brief', provider: 'anthropic', model: 'claude-opus-5-5', attempts: 1, cached: false, pricingKnown: true });
    // 1200 × $4 + 340 × $20 + 900 × $0.20 + 50 × $5 per MTok
    expect(briefUsage?.estimatedCostUsd).toBeCloseTo((1200 * 4 + 340 * 20 + 900 * 0.2 + 50 * 5) / 1e6, 12);
  });
});
