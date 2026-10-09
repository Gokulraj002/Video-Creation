import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS } from '@vc/schema';
import { AIDirector, DirectorError, HeuristicMockProvider, type DirectorProgress } from '../src';
import { delegatingProvider, makeRequest } from './helpers';

async function failure(promise: Promise<unknown>): Promise<DirectorError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DirectorError);
  return err as DirectorError;
}

describe('cancellation', () => {
  it('a pre-aborted signal cancels before any provider call', async () => {
    const provider = delegatingProvider();
    const controller = new AbortController();
    controller.abort();
    const err = await failure(new AIDirector({ provider }).planProject({ request: makeRequest() }, { signal: controller.signal }));
    expect(err.code).toBe('CANCELLED');
    expect(provider.calls).toHaveLength(0);
    expect(err.usage?.stages).toEqual([]);
  });

  it('aborting mid-run stops before the next provider call and keeps the usage so far', async () => {
    const controller = new AbortController();
    const provider = delegatingProvider(async (req, callIndex) => {
      if (callIndex !== 2) return undefined;
      // The first chapter's script call succeeds, then the user cancels.
      const out = await new HeuristicMockProvider().generateStructured({ ...req, signal: undefined });
      controller.abort();
      return out.output;
    });
    const request = makeRequest({ genre: 'long-form', durationSeconds: 600 });
    const err = await failure(new AIDirector({ provider }).planProject({ request }, { signal: controller.signal }));
    expect(err.code).toBe('CANCELLED');
    expect(provider.calls).toHaveLength(3);
    expect(err.usage?.stages.map((s) => s.stage)).toEqual(['brief', 'outline', 'script']);
    expect(err.usage?.totals.calls).toBe(3);
  });

  it('cancels a regeneration', async () => {
    const request = makeRequest();
    const base = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject({ request });
    const controller = new AbortController();
    controller.abort();
    const err = await failure(
      new AIDirector({ provider: new HeuristicMockProvider() }).regenerateScene(
        { request, artifacts: base.artifacts, sceneId: 'c1-s2' },
        { signal: controller.signal },
      ),
    );
    expect(err.code).toBe('CANCELLED');
  });
});

describe('limits', () => {
  it('fails fast with LIMIT_EXCEEDED before any provider call', async () => {
    const provider = delegatingProvider();
    const err = await failure(new AIDirector({ provider }).planProject({ request: makeRequest({ durationSeconds: 7201 }) }));
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(provider.calls).toHaveLength(0);
    expect(JSON.stringify(err.details)).toContain('MAX_DURATION_SECONDS');
    expect(err.usage?.totals.calls).toBe(0);
  });

  it('applies configured (not hardcoded) limits', async () => {
    const provider = delegatingProvider();
    const limits = { ...DEFAULT_RESOURCE_LIMITS, maxDurationSeconds: 60, maxFps: 30 };
    const director = new AIDirector({ provider, limits });
    await expect(director.planProject({ request: makeRequest({ durationSeconds: 61 }) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(director.planProject({ request: makeRequest({ durationSeconds: 10, fps: 60 }) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(provider.calls).toHaveLength(0);
    const ok = await director.planProject({ request: makeRequest({ durationSeconds: 60 }) });
    expect(ok.timeline.durationInFrames).toBe(1800);
    // Longer than the default 2 h when the app raises the limit.
    const long = new AIDirector({ provider: new HeuristicMockProvider(), limits: { ...DEFAULT_RESOURCE_LIMITS, maxDurationSeconds: 3 * 3600 } });
    expect(long.plan(makeRequest({ genre: 'long-form', durationSeconds: 3 * 3600 })).chapterCount).toBe(38);
  });

  it('rejects an invalid request with VALIDATION_FAILED', async () => {
    const provider = delegatingProvider();
    const bad = { ...makeRequest(), durationSeconds: -5 };
    await expect(new AIDirector({ provider }).planProject({ request: bad })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(provider.calls).toHaveLength(0);
  });
});

describe('progress', () => {
  it('reports every stage with totalSteps = 2 + 5 × chapters + 1', async () => {
    const events: DirectorProgress[] = [];
    const request = makeRequest({ genre: 'long-form', durationSeconds: 600 });
    const result = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject({ request }, { onProgress: (p) => void events.push(p) });
    const total = 2 + 5 * result.plan.chapterCount + 1;
    expect(events.every((e) => e.totalSteps === total)).toBe(true);
    expect(events.map((e) => e.completedSteps)).toEqual([...events.map((e) => e.completedSteps)].sort((a, b) => a - b));
    expect(events[0]).toMatchObject({ stage: 'brief', chunk: null, completedSteps: 0 });
    expect(events.filter((e) => e.stage === 'script').map((e) => e.chunk)).toEqual(['c1', 'c2', 'c3']);
    expect(events.at(-1)).toMatchObject({ stage: 'compile', completedSteps: total });
  });

  it('a failing progress callback does not break the run', async () => {
    const result = await new AIDirector({ provider: new HeuristicMockProvider() }).planProject(
      { request: makeRequest() },
      {
        onProgress: () => {
          throw new Error('db down');
        },
      },
    );
    expect(result.timeline.scenes.length).toBeGreaterThan(0);
  });
});
