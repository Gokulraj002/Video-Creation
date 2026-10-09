import { describe, expect, it } from 'vitest';
import { buildArtifacts, buildTimeline } from '@/test/fixtures';
import { STORYBOARD_INITIAL_SCENES, StoryboardPageSchema, buildStoryboard, pageChapterRows, planStoryboard } from './storyboard';

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

describe('storyboard paging', () => {
  const chapters = buildStoryboard(buildArtifacts(), buildTimeline());

  it('rows round-trip through the client validation schema', () => {
    const page = pageChapterRows(chapters, 'c1', 0, 10);
    expect(page).not.toBeNull();
    expect(StoryboardPageSchema.safeParse(JSON.parse(JSON.stringify(page))).success).toBe(true);
  });

  it('pages one chapter and clamps the page size', () => {
    expect(pageChapterRows(chapters, 'c1', 1, 10)).toMatchObject({ chapterId: 'c1', offset: 1, total: 2 });
    expect(pageChapterRows(chapters, 'c1', 1, 10)?.rows.map((r) => r.index)).toEqual([1]);
    expect(pageChapterRows(chapters, 'c1', 0, 0)?.rows).toHaveLength(1);
    expect(pageChapterRows(chapters, 'nope', 0, 10)).toBeNull();
  });

  it('renders only a budget of cards on first load', () => {
    const planned = planStoryboard(chapters, { sceneBudget: 2, openChapters: 3 });
    expect(planned.map((p) => [p.header.id, p.open, p.initialRows.length, p.header.sceneCount])).toEqual([
      ['c1', true, 2, 2],
      ['c2', false, 0, 1],
    ]);
    // The first chapter is always expanded, even when it alone exceeds the budget (only a prefix is rendered).
    const tight = planStoryboard(chapters, { sceneBudget: 1 });
    expect(tight[0]).toMatchObject({ open: true });
    expect(tight[0]?.initialRows).toHaveLength(1);
    expect('rows' in (tight[0]?.header ?? {})).toBe(false);
  });

  it('caps a 2,000-scene storyboard to the initial budget', () => {
    const base = chapters[0];
    if (!base?.rows[0]) throw new Error('fixture');
    const row = base.rows[0];
    const big = Array.from({ length: 84 }, (_, c) => ({
      ...base,
      id: `ch${c}`,
      rows: Array.from({ length: 24 }, (_, i) => ({ ...row, index: c * 24 + i, id: `s${c}-${i}` })),
    }));
    const planned = planStoryboard(big);
    const rendered = planned.reduce((n, p) => n + p.initialRows.length, 0);
    expect(rendered).toBe(STORYBOARD_INITIAL_SCENES);
    expect(planned.filter((p) => p.open)).toHaveLength(3);
  });
});
