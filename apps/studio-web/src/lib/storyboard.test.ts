import { describe, expect, it } from 'vitest';
import { buildArtifacts, buildTimeline } from '@/test/fixtures';
import { buildStoryboard } from './storyboard';

describe('buildStoryboard', () => {
  it('groups scenes by chapter with exact timeline frames', () => {
    const chapters = buildStoryboard(buildArtifacts(), buildTimeline());
    expect(chapters.map((c) => [c.id, c.rows.length])).toEqual([
      ['c1', 2],
      ['c2', 1],
    ]);
    const [first, second] = chapters[0]?.rows ?? [];
    expect(first).toMatchObject({
      index: 0,
      startFrame: 0,
      durationInFrames: 90,
      engine: 'motion2d',
      template: 'title-card',
      cameraPreset: 'push-in',
      shotType: 'medium',
      transitionIn: null,
      engineRationale: 'Strong open',
      voiceOver: 'Meet Aurora, the lamp that adapts to you.',
    });
    expect(first?.shots.map((s) => s.id)).toEqual(['sh1']);
    expect(second).toMatchObject({ engine: 'three', template: 'product-turntable', transitionIn: 'crossfade', startFrame: 90 });
    expect(chapters[1]?.summary).toBe('What it does');
    expect(chapters[1]?.rows[0]?.transitionIn).toBe('slide');
  });
});
