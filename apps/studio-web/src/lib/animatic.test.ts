import type { JsonObject, SceneContent } from '@vc/schema';
import { describe, expect, it } from 'vitest';
import { buildTimeline, templateProps } from '@/test/fixtures';
import {
  DEFAULT_BRAND_COLORS,
  activeCaption,
  easeInOut,
  findSpanIndex,
  primaryCaptionTrack,
  primaryTemplateText,
  readableTextColor,
  resolveBrandColors,
  sceneColors,
  secondaryTemplateLines,
  transitionFrames,
  transitionProgress,
} from './animatic';

const motion = (template: string, props: JsonObject): SceneContent => ({ engine: 'motion2d', template, props, layers: [] });

describe('findSpanIndex', () => {
  const timeline = buildTimeline();

  it('finds the scene containing a frame using integer frame spans', () => {
    expect(findSpanIndex(timeline.scenes, 0)).toBe(0);
    expect(findSpanIndex(timeline.scenes, 89)).toBe(0);
    expect(findSpanIndex(timeline.scenes, 90)).toBe(1);
    expect(findSpanIndex(timeline.scenes, 299)).toBe(2);
  });

  it('returns -1 outside the timeline', () => {
    expect(findSpanIndex(timeline.scenes, 300)).toBe(-1);
    expect(findSpanIndex(timeline.scenes, -1)).toBe(-1);
    expect(findSpanIndex([], 0)).toBe(-1);
  });

  it('scales to long timelines', () => {
    const spans = Array.from({ length: 2000 }, (_, i) => ({ startFrame: i * 100, durationInFrames: 100 }));
    expect(findSpanIndex(spans, 123_456)).toBe(1234);
  });
});

describe('captions', () => {
  it('returns the active caption cue', () => {
    const timeline = buildTimeline();
    const track = primaryCaptionTrack(timeline);
    expect(track?.id).toBe('cap');
    expect(activeCaption(track, 10)?.text).toBe('Meet Aurora,');
    expect(activeCaption(track, 45)?.id).toBe('cue-2');
    expect(activeCaption(track, 200)).toBeNull();
    expect(activeCaption(null, 0)).toBeNull();
  });
});

describe('template text', () => {
  it('derives the primary text from template props', () => {
    const timeline = buildTimeline();
    const [title, product, bullets] = timeline.scenes;
    expect(title && primaryTemplateText(title.content, 'fallback')).not.toBe('fallback');
    expect(product && primaryTemplateText(product.content, 'fallback').length).toBeGreaterThan(0);
    expect(bullets && secondaryTemplateLines(bullets.content).length).toBeGreaterThan(0);
  });

  it('handles specific templates', () => {
    expect(primaryTemplateText(motion('kinetic-text', { lines: ['Bold', 'moves'] }), 'x')).toBe('Bold moves');
    expect(
      primaryTemplateText(motion('stat-counter', { value: 42.5, decimals: 1, prefix: null, suffix: '%', label: 'faster' }), 'x'),
    ).toBe('42.5%');
    expect(secondaryTemplateLines(motion('stat-counter', { value: 1, label: 'faster' }))).toEqual(['faster']);
    expect(
      secondaryTemplateLines(
        motion('step-instruction', { stepNumber: 2, totalSteps: 5, title: 'Lock out', instruction: 'Turn the key', caution: 'Hot' }),
      ),
    ).toEqual(['Step 2 of 5', 'Turn the key', '⚠ Hot']);
    expect(primaryTemplateText(motion('cta-end-card', templateProps('cta-end-card')), 'x')).not.toBe('x');
  });

  it('falls back to the scene title for non-template engines', () => {
    const footage: SceneContent = {
      engine: 'footage',
      assetId: 'a1',
      trimStartFrame: 0,
      playbackRate: 1,
      fit: 'cover',
      volume: 1,
      muted: false,
    };
    expect(primaryTemplateText(footage, 'Scene title')).toBe('Scene title');
    expect(secondaryTemplateLines(footage)).toEqual([]);
  });
});

describe('colors', () => {
  it('uses brand colors with defaults', () => {
    expect(resolveBrandColors({ brand: undefined })).toEqual(DEFAULT_BRAND_COLORS);
    expect(resolveBrandColors(buildTimeline()).accent).toBe('#ffaa00');
  });

  it('prefers valid template colors over the brand', () => {
    const brand = DEFAULT_BRAND_COLORS;
    const colors = sceneColors(motion('quote', { quote: 'q', backgroundColor: '#ffffff', accentColor: '#ff0000' }), brand);
    expect(colors).toEqual({ background: '#ffffff', accent: '#ff0000', gradient: null });
    const invalid = sceneColors(motion('quote', { backgroundColor: 'red' }), brand);
    expect(invalid.background).toBe(brand.background);
    const gradient = sceneColors(
      motion('title-card', { background: { style: 'gradient', colors: ['#000000', '#222222'] } }),
      brand,
    );
    expect(gradient.gradient).toEqual(['#000000', '#222222']);
  });

  it('picks a readable foreground', () => {
    expect(readableTextColor('#ffffff')).toBe('#0b0d12');
    expect(readableTextColor('#000000')).toBe('#f8fafc');
    expect(readableTextColor('nope')).toBe('#f8fafc');
  });
});

describe('transitions', () => {
  it('computes transition frames and progress', () => {
    expect(transitionFrames(undefined, 90)).toBe(0);
    expect(transitionFrames({ type: 'cut', durationInFrames: 0, easing: 'linear' }, 90)).toBe(0);
    expect(transitionFrames({ type: 'fade', durationInFrames: 15, easing: 'linear' }, 90)).toBe(15);
    expect(transitionFrames({ type: 'fade', durationInFrames: 200, easing: 'linear' }, 90)).toBe(90);
    expect(transitionProgress(0, 15)).toBe(0);
    expect(transitionProgress(15, 15)).toBe(1);
    expect(transitionProgress(5, 0)).toBe(1);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(2)).toBe(1);
  });
});
