import { describe, expect, it } from 'vitest';
import {
  AIDirector,
  computeCacheKey,
  MemoryDirectorCache,
  STAGE_OUTPUT_SCHEMAS,
  type CacheEntry,
  type CacheLookupContext,
  type DirectorCache,
  type LlmStage,
} from '../src';
import { delegatingProvider, makeRequest, stableTimeline } from './helpers';

const entry = (output: unknown): CacheEntry => ({
  stage: 'brief',
  chunk: null,
  output,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  provider: 'mock',
  model: 'mock-director-v1',
  createdAt: '2026-10-09T00:00:00.000Z',
});

class RecordingCache implements DirectorCache {
  readonly inner = new MemoryDirectorCache();
  readonly sets: { key: string; entry: CacheEntry }[] = [];
  readonly gets: { key: string; context: CacheLookupContext | undefined }[] = [];

  async get(key: string, context?: CacheLookupContext): Promise<CacheEntry | null> {
    this.gets.push({ key, context });
    return this.inner.get(key);
  }

  async set(key: string, value: CacheEntry): Promise<void> {
    this.sets.push({ key, entry: value });
    await this.inner.set(key, value);
  }
}

describe('MemoryDirectorCache', () => {
  it('evicts the least recently used entry', async () => {
    const cache = new MemoryDirectorCache(2);
    await cache.set('a', entry(1));
    await cache.set('b', entry(2));
    expect((await cache.get('a'))?.output).toBe(1); // a is now most recent
    await cache.set('c', entry(3));
    expect(await cache.get('b')).toBeNull();
    expect((await cache.get('a'))?.output).toBe(1);
    expect((await cache.get('c'))?.output).toBe(3);
    expect(cache.size).toBe(2);
  });
});

describe('computeCacheKey', () => {
  const parts = {
    stage: 'brief' as const,
    chunk: null,
    promptVersion: 'm1.0',
    provider: 'mock',
    model: 'mock-director-v1',
    schemaName: 'creative_brief',
    system: 'SYS',
    prompt: 'PROMPT',
  };

  it('is a stable sha256 hex digest of the canonical parts', () => {
    const key = computeCacheKey(parts);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(parts).reverse()) as typeof parts;
    expect(computeCacheKey(reordered)).toBe(key);
  });

  it('changes with any part', () => {
    const key = computeCacheKey(parts);
    expect(computeCacheKey({ ...parts, prompt: 'PROMPT2' })).not.toBe(key);
    expect(computeCacheKey({ ...parts, promptVersion: 'm1.1' })).not.toBe(key);
    expect(computeCacheKey({ ...parts, chunk: 'c1' })).not.toBe(key);
    expect(computeCacheKey({ ...parts, model: 'claude-opus-5-5' })).not.toBe(key);
  });
});

describe('director caching', () => {
  it('a second identical run makes 0 provider calls and reports cached calls', async () => {
    const cache = new RecordingCache();
    const provider = delegatingProvider();
    const director = new AIDirector({ provider, cache });
    const request = makeRequest({ genre: 'long-form', durationSeconds: 400 });

    const first = await director.planProject({ request });
    const callsAfterFirst = provider.calls.length;
    expect(callsAfterFirst).toBe(first.usage.stages.length);
    expect(first.usage.totals.cachedCalls).toBe(0);

    const second = await director.planProject({ request });
    expect(provider.calls.length).toBe(callsAfterFirst);
    expect(second.usage.totals.calls).toBe(0);
    expect(second.usage.totals.cachedCalls).toBe(first.usage.stages.length);
    expect(second.usage.totals.inputTokens + second.usage.totals.outputTokens).toBe(0);
    expect(second.usage.totals.estimatedCostUsd).toBe(0);
    expect(second.usage.stages.every((s) => s.cached && s.attempts === 1 && s.usage.inputTokens === 0)).toBe(true);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(stableTimeline(second.timeline)).toEqual(stableTimeline(first.timeline));
  });

  it('caches only validated outputs and records stage/chunk on entries and lookups', async () => {
    const cache = new RecordingCache();
    let bad = true;
    const provider = delegatingProvider((req) => {
      if (req.stage === 'script' && bad) {
        bad = false;
        return { chapterId: 'c1', segments: [] };
      }
      return undefined;
    });
    await new AIDirector({ provider, cache }).planProject({ request: makeRequest() });
    expect(cache.sets.length).toBe(7);
    for (const { entry: e } of cache.sets) {
      const schema = STAGE_OUTPUT_SCHEMAS[e.stage as LlmStage];
      expect(schema.safeParse(e.output).success).toBe(true);
      expect(e.provider).toBe('scripted-mock');
    }
    expect(cache.sets.map((s) => s.entry.stage)).toEqual(['brief', 'outline', 'script', 'storyboard', 'shotList', 'engineSelection', 'sceneSpecs']);
    expect(cache.sets.map((s) => s.entry.chunk)).toEqual([null, null, 'c1', 'c1', 'c1', 'c1', 'c1']);
    expect(cache.gets.map((g) => g.context?.stage)).toEqual(cache.sets.map((s) => s.entry.stage));
    expect((cache.sets[2]?.entry.output as { segments: unknown[] }).segments.length).toBeGreaterThan(0);
  });

  it('ignores cache entries that no longer validate', async () => {
    const cache = new MemoryDirectorCache();
    const provider = delegatingProvider();
    const director = new AIDirector({ provider, cache });
    const request = makeRequest();
    await director.planProject({ request });
    const calls = provider.calls.length;
    // Corrupt every entry.
    const internal = cache as unknown as { entries: Map<string, CacheEntry> };
    for (const [k, v] of internal.entries) internal.entries.set(k, { ...v, output: { corrupted: true } });
    const again = await director.planProject({ request });
    expect(provider.calls.length).toBe(calls * 2);
    expect(again.usage.totals.cachedCalls).toBe(0);
  });
});
