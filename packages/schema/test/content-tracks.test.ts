import { describe, expect, it } from 'vitest';
import {
  AssetRefSchema,
  BrandKitSchema,
  ChapterSchema,
  EngineTypeSchema,
  Layer2DSchema,
  OverlayContentSchema,
  SceneContentSchema,
  SceneSchema,
  TrackSchema,
} from '../src/index';
import { buildValidTimeline } from './fixtures';
import { expectIssueAt, expectSuccess } from './helpers';

const t = buildValidTimeline();

describe('AssetRefSchema', () => {
  it('accepts every fixture asset', () => {
    for (const a of t.assets) expectSuccess(AssetRefSchema.safeParse(a));
  });
  it.each([
    ['kind', { kind: 'pdf' }],
    ['source', { source: 'scraped' }],
    ['mimeType', { mimeType: 'x'.repeat(60) + '/' + 'y'.repeat(70) }],
    ['sizeBytes', { sizeBytes: -1 }],
    ['durationInFrames', { durationInFrames: 0 }],
    ['id', { id: 'bad id' }],
  ])('rejects invalid %s', (path, patch) => {
    expectIssueAt(AssetRefSchema.safeParse({ ...t.assets[0], ...patch }), [path]);
  });
});

describe('Layer2DSchema', () => {
  const content = t.scenes[0]?.content;
  const layers = content?.engine === 'motion2d' ? content.layers : [];
  const text = layers[0];

  it('accepts text, shape and image layers', () => {
    expect(layers.map((l) => l.type)).toEqual(['text', 'shape', 'image']);
    for (const l of layers) expectSuccess(Layer2DSchema.safeParse(l));
  });

  it.each([
    ['opacity', { opacity: 1.1 }],
    ['x', { x: -0.1 }],
    ['maxWidth', { maxWidth: 2 }],
    ['fontSize', { fontSize: 3 }],
    ['fontSize', { fontSize: 401 }],
    ['fontWeight', { fontWeight: 950 }],
    ['align', { align: 'justify' }],
    ['enter', { enter: 'explode' }],
    ['text', { text: 'x'.repeat(2001) }],
    ['color', { color: 'white' }],
    ['fontFamily', { fontFamily: 'Comic;Sans' }],
  ])('rejects text layer with invalid %s', (path, patch) => {
    expectIssueAt(Layer2DSchema.safeParse({ ...text, ...patch }), [path]);
  });

  it('rejects unknown layer types', () => {
    expectIssueAt(Layer2DSchema.safeParse({ ...text, type: 'video' }), ['type']);
  });
});

describe('SceneContentSchema', () => {
  it('accepts every engine', () => {
    expect(EngineTypeSchema.options).toEqual(['motion2d', 'three', 'footage', 'generated', 'image', 'screen']);
    for (const s of t.scenes) expectSuccess(SceneContentSchema.safeParse(s.content));
  });

  const byEngine = Object.fromEntries(t.scenes.map((s) => [s.content.engine, s.content]));

  it.each([
    ['motion2d', 'template', { template: 'Bad Template' }],
    ['motion2d', 'props', { props: 'x' }],
    ['three', 'environment', { environment: 'moon' }],
    ['three', 'lighting', { lighting: 'neon' }],
    ['footage', 'playbackRate', { playbackRate: 0.2 }],
    ['footage', 'playbackRate', { playbackRate: 4.5 }],
    ['footage', 'volume', { volume: 1.5 }],
    ['footage', 'trimStartFrame', { trimStartFrame: -1 }],
    ['generated', 'prompt', { prompt: 'x'.repeat(4001) }],
    ['generated', 'status', { status: 'done' }],
    ['generated', 'seed', { seed: 1.5 }],
    ['generated', 'provider', { provider: 'bad provider' }],
    ['image', 'animation', { animation: 'spin' }],
    ['image', 'focalPoint', { focalPoint: { x: 2, y: 0 } }],
    ['screen', 'zoomRegions', { zoomRegions: [{ startFrame: 0, durationInFrames: 0, x: 0, y: 0, width: 1, height: 1 }] }],
  ])('%s: rejects invalid %s', (engine, path, patch) => {
    const result = SceneContentSchema.safeParse({ ...byEngine[engine], ...patch });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === path)).toBe(true);
    }
  });

  it('rejects unknown engines', () => {
    expect(SceneContentSchema.safeParse({ engine: 'unreal' }).success).toBe(false);
  });

  it('OverlayContentSchema only allows motion2d and image', () => {
    expectSuccess(OverlayContentSchema.safeParse(byEngine.motion2d));
    expectSuccess(OverlayContentSchema.safeParse(byEngine.image));
    expect(OverlayContentSchema.safeParse(byEngine.footage).success).toBe(false);
    expect(OverlayContentSchema.safeParse(byEngine.three).success).toBe(false);
  });
});

describe('SceneSchema / ChapterSchema / BrandKitSchema', () => {
  it('accepts fixture scenes and chapters', () => {
    for (const s of t.scenes) expectSuccess(SceneSchema.safeParse(s));
    for (const c of t.chapters) expectSuccess(ChapterSchema.safeParse(c));
    expectSuccess(BrandKitSchema.safeParse(t.brand));
  });

  it('enforces text bounds', () => {
    const s = t.scenes[0];
    expectIssueAt(SceneSchema.safeParse({ ...s, title: 'x'.repeat(201) }), ['title']);
    expectIssueAt(SceneSchema.safeParse({ ...s, notes: 'x'.repeat(2001) }), ['notes']);
    expectIssueAt(SceneSchema.safeParse({ ...s, narration: { text: 'x'.repeat(5001) } }), ['narration', 'text']);
    expectIssueAt(SceneSchema.safeParse({ ...s, durationInFrames: 0 }), ['durationInFrames']);
    const c = t.chapters[0];
    expectIssueAt(ChapterSchema.safeParse({ ...c, summary: 'x'.repeat(2001) }), ['summary']);
    expectIssueAt(BrandKitSchema.safeParse({ ...t.brand, name: 'x'.repeat(121) }), ['name']);
    expectIssueAt(BrandKitSchema.safeParse({ ...t.brand, fonts: { heading: 'Inter', body: 'x;y' } }), ['fonts', 'body']);
  });
});

describe('TrackSchema', () => {
  it('accepts every track kind', () => {
    for (const track of t.tracks) expectSuccess(TrackSchema.safeParse(track));
  });

  const byKind = Object.fromEntries(t.tracks.map((tr) => [tr.kind, tr]));

  it.each([
    ['audio', ['role'], { role: 'podcast' }],
    ['audio', ['volume'], { volume: 2.1 }],
    ['caption', ['style', 'preset'], { style: { preset: 'fancy', position: 'bottom', color: '#FFFFFF' } }],
    ['caption', ['style', 'fontSize'], { style: { preset: 'lower', position: 'top', color: '#FFFFFF', fontSize: 7 } }],
    ['caption', ['language'], { language: 'English' }],
    ['caption', ['items', 0, 'text'], { items: [{ id: 'c1', startFrame: 0, durationInFrames: 1, text: 'x'.repeat(501) }] }],
    ['video', ['items', 0, 'playbackRate'], { items: [{ ...byKindItem('video'), playbackRate: 10 }] }],
    ['overlay', ['items', 0, 'zIndex'], { items: [{ ...byKindItem('overlay'), zIndex: 1.5 }] }],
  ])('%s: rejects invalid %j', (kind, path, patch) => {
    expectIssueAt(TrackSchema.safeParse({ ...byKind[kind], ...patch }), path);
  });

  it('rejects overlay items with footage content', () => {
    const footage = t.scenes.find((s) => s.content.engine === 'footage')?.content;
    const result = TrackSchema.safeParse({ ...byKind.overlay, items: [{ ...byKindItem('overlay'), content: footage }] });
    expect(result.success).toBe(false);
  });

  function byKindItem(kind: string): Record<string, unknown> {
    const track = t.tracks.find((tr) => tr.kind === kind);
    const item = track?.items[0];
    if (!item) throw new Error(`no ${kind} item`);
    return { ...item };
  }
});
