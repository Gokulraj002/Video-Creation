import { describe, expect, it } from 'vitest';
import type { ChapterEngineSelection, EngineSelectionStageInput } from '../src';
import { AIDirector, coerceEngineChoice, HeuristicMockProvider, resolveEngineAvailability } from '../src';
import { delegatingProvider, expectValidResult, makeRequest } from './helpers';

describe('coerceEngineChoice', () => {
  const availability = resolveEngineAvailability();
  const choice = { sceneId: 's1', engine: 'generated' as const, template: null, provider: 'runway', rationale: 'Cinematic AI footage' };

  it('keeps available motion2d/three choices', () => {
    const ok = { sceneId: 's1', engine: 'three' as const, template: 'product-turntable', provider: null, rationale: 'Hero' };
    expect(coerceEngineChoice(ok, { genre: 'promo', availability, isFirst: false, isLast: false, hasCallToAction: true })).toEqual({ choice: ok, warning: null });
  });

  it('coerces unavailable engines to genre-appropriate motion2d templates with a warning', () => {
    const first = coerceEngineChoice(choice, { genre: 'real-estate', availability, isFirst: true, isLast: false, hasCallToAction: true });
    expect(first.choice).toMatchObject({ engine: 'motion2d', template: 'title-card', provider: null });
    expect(first.warning).toContain('engine "generated" is unavailable (no video provider configured)');
    const last = coerceEngineChoice(choice, { genre: 'real-estate', availability, isFirst: false, isLast: true, hasCallToAction: true });
    expect(last.choice.template).toBe('cta-end-card');
    const lastNoCta = coerceEngineChoice(choice, { genre: 'real-estate', availability, isFirst: false, isLast: true, hasCallToAction: false });
    expect(lastNoCta.choice.template).toBe('property-showcase');
    expect(coerceEngineChoice(choice, { genre: 'sop-training', availability, isFirst: false, isLast: false, hasCallToAction: false }).choice.template).toBe('step-instruction');
    expect(coerceEngineChoice(choice, { genre: 'cartoon', availability, isFirst: false, isLast: false, hasCallToAction: false }).choice.template).toBe('cartoon-scene');
    const footage = coerceEngineChoice({ ...choice, engine: 'footage', provider: null }, { genre: 'promo', availability, isFirst: false, isLast: false, hasCallToAction: false });
    expect(footage.warning).toContain('(no assets)');
  });

  it('never enables engines the M1 compiler cannot render', () => {
    const custom = resolveEngineAvailability({ footage: { available: true, reason: null }, three: { available: false, reason: 'no GPU' } });
    expect(custom.footage.available).toBe(false);
    expect(custom.three).toEqual({ available: false, reason: 'no GPU' });
    expect(custom.motion2d.available).toBe(true);
  });
});

describe('engine coercion in the pipeline', () => {
  it('records a warning for every coerced scene and still compiles', async () => {
    const provider = delegatingProvider((req) => {
      if (req.stage !== 'engineSelection') return undefined;
      const input = req.input as EngineSelectionStageInput;
      const out: ChapterEngineSelection = {
        chapterId: input.chapter.id,
        choices: input.scenes.map((p) => ({ sceneId: p.scene.id, engine: 'generated', template: null, provider: 'veo', rationale: 'AI video' })),
      };
      return out;
    });
    const request = makeRequest({ genre: 'promo', durationSeconds: 20 });
    const result = await new AIDirector({ provider }).planProject({ request });
    expectValidResult(result, request);
    const n = result.timeline.scenes.length;
    const coercions = result.warnings.filter((w) => w.includes('engine "generated" is unavailable'));
    expect(coercions).toHaveLength(n);
    expect(result.artifacts.engineSelection.choices.every((c) => c.engine === 'motion2d' && c.provider === null)).toBe(true);
    expect(result.artifacts.engineSelection.choices[0]?.template).toBe('title-card');
    expect(result.artifacts.engineSelection.choices.at(-1)?.template).toBe('cta-end-card');
    expect(result.timeline.scenes.every((s) => s.content.engine === 'motion2d')).toBe(true);
    // The scene-specs prompt only lists the templates actually selected.
    const specsCall = provider.calls.find((c) => c.stage === 'sceneSpecs');
    expect(specsCall?.prompt).toContain('"id":"split-feature"');
    expect(specsCall?.prompt).not.toContain('"id":"product-turntable"');
  });

  it('coerces 3D choices when the three engine is disabled', async () => {
    const director = new AIDirector({ provider: new HeuristicMockProvider(), engineAvailability: { three: { available: false, reason: 'no GPU' } } });
    const request = makeRequest({ genre: 'product-3d', durationSeconds: 30 });
    const result = await director.planProject({ request });
    expectValidResult(result, request);
    expect(result.timeline.scenes.every((s) => s.content.engine === 'motion2d')).toBe(true);
  });

  it('rejects templates that do not belong to the chosen engine (repair)', async () => {
    let first = true;
    const provider = delegatingProvider((req) => {
      if (req.stage !== 'engineSelection' || !first) return undefined;
      first = false;
      const input = req.input as EngineSelectionStageInput;
      return {
        chapterId: input.chapter.id,
        choices: input.scenes.map((p) => ({ sceneId: p.scene.id, engine: 'motion2d', template: 'product-turntable', provider: null, rationale: 'x' })),
      };
    });
    const result = await new AIDirector({ provider }).planProject({ request: makeRequest() });
    expect(result.usage.stages.find((s) => s.stage === 'engineSelection')?.attempts).toBe(2);
    expect(provider.calls.filter((c) => c.stage === 'engineSelection')[1]?.prompt).toContain('is a "three" template, not "motion2d"');
  });
});
