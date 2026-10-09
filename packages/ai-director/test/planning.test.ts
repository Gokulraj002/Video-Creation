import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS, VideoGenreSchema } from '@vc/schema';
import { DirectorError, GENRE_TARGET_SCENE_SECONDS, planStructure, totalStepsFor } from '../src';
import { makeReference, makeRequest } from './helpers';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('planStructure', () => {
  it('has a target scene length for every genre', () => {
    for (const genre of VideoGenreSchema.options) expect(GENRE_TARGET_SCENE_SECONDS[genre]).toBeGreaterThan(0);
    expect(GENRE_TARGET_SCENE_SECONDS['social-short']).toBe(2.5);
    expect(GENRE_TARGET_SCENE_SECONDS['sop-training']).toBe(9);
    expect(GENRE_TARGET_SCENE_SECONDS['long-form']).toBe(12);
  });

  it('plans a 30 s promo as one chapter of 6..12 scenes', () => {
    const plan = planStructure(makeRequest({ genre: 'promo', durationSeconds: 30 }));
    expect(plan.totalFrames).toBe(900);
    expect(plan.targetSceneSeconds).toBe(3.5);
    expect(plan.sceneCountRange).toEqual({ min: 6, max: 12 }); // expected round(30/3.5) = 9
    expect(plan.chapterCount).toBe(1);
    expect(plan.chunked).toBe(false);
    expect(plan.chapterTargetSeconds).toEqual([30]);
    expect(plan.perChapterSceneRange).toEqual([{ min: 6, max: 12 }]);
    expect(totalStepsFor(plan)).toBe(8);
  });

  it('never plans more scenes than whole seconds; sub-second videos get exactly one scene', () => {
    expect(planStructure(makeRequest({ genre: 'social-short', durationSeconds: 5 })).sceneCountRange).toEqual({ min: 1, max: 3 });
    expect(planStructure(makeRequest({ genre: 'social-short', durationSeconds: 2 })).sceneCountRange.max).toBeLessThanOrEqual(2);
    const tiny = planStructure(makeRequest({ genre: 'social-short', durationSeconds: 0.4 }));
    expect(tiny.sceneCountRange).toEqual({ min: 1, max: 1 });
    expect(tiny.totalFrames).toBe(12);
  });

  it('chunks a 10-minute long-form video into chapters with exact targets', () => {
    const plan = planStructure(makeRequest({ genre: 'long-form', durationSeconds: 600 }));
    // expected = 50 scenes, chapters = max(ceil(600/300), ceil(50/24)) = 3
    expect(plan.chapterCount).toBe(3);
    expect(plan.chunked).toBe(true);
    expect(plan.sceneCountRange).toEqual({ min: 37, max: 63 });
    expect(Math.abs(sum(plan.chapterTargetSeconds) - 600)).toBeLessThan(1e-6);
    expect(sum(plan.perChapterSceneRange.map((r) => r.max))).toBe(63);
    expect(sum(plan.perChapterSceneRange.map((r) => r.min))).toBe(37);
    for (const r of plan.perChapterSceneRange) expect(r.min).toBeLessThanOrEqual(r.max);
  });

  it('supports 2-hour videos within maxScenes / maxChapters', () => {
    const plan = planStructure(makeRequest({ genre: 'social-short', durationSeconds: 7200 }));
    expect(plan.sceneCountRange.max).toBe(DEFAULT_RESOURCE_LIMITS.maxScenes);
    expect(plan.sceneCountRange.min).toBe(1500);
    expect(plan.chapterCount).toBe(84); // max(ceil(7200/300)=24, ceil(2000/24)=84)
    expect(Math.abs(sum(plan.chapterTargetSeconds) - 7200)).toBeLessThan(1e-6);
    expect(sum(plan.perChapterSceneRange.map((r) => r.max))).toBe(2000);
    const longForm = planStructure(makeRequest({ genre: 'long-form', durationSeconds: 7200 }));
    expect(longForm.chapterCount).toBe(25);
  });

  it('respects configurable limits (not hardcoded maxima)', () => {
    const limits = { ...DEFAULT_RESOURCE_LIMITS, maxScenes: 5, maxChapters: 3, maxDurationSeconds: 100_000 };
    const plan = planStructure(makeRequest({ genre: 'long-form', durationSeconds: 36_000 }), [], limits);
    expect(plan.sceneCountRange.max).toBeLessThanOrEqual(5);
    expect(plan.chapterCount).toBeLessThanOrEqual(3);
    expect(plan.totalFrames).toBe(36_000 * 30);
  });

  it('fails fast above maxDurationSeconds', () => {
    try {
      planStructure(makeRequest({ durationSeconds: 7201 }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DirectorError);
      expect((err as DirectorError).code).toBe('LIMIT_EXCEEDED');
    }
  });

  it('uses reference pacing (clamped 1.5..20 s) for reference-based videos', () => {
    const request = makeRequest({ genre: 'reference-based', durationSeconds: 60 });
    expect(planStructure(request, [makeReference()]).targetSceneSeconds).toBe(4);
    expect(planStructure(request, [makeReference({ pacing: { averageShotSeconds: 45, cutsPerMinute: 1 } })]).targetSceneSeconds).toBe(20);
    expect(planStructure(request, [makeReference({ pacing: { averageShotSeconds: 0.5, cutsPerMinute: 120 } })]).targetSceneSeconds).toBe(1.5);
    expect(planStructure(request).targetSceneSeconds).toBe(5);
    // Other genres ignore reference pacing.
    expect(planStructure(makeRequest({ genre: 'explainer', durationSeconds: 60 }), [makeReference()]).targetSceneSeconds).toBe(7);
  });
});
