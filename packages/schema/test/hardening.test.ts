/**
 * Regression tests for the schema hardening review (allocation overflow, surrogate-safe clipping, blank requests,
 * timeline size limits, SafeUri bypasses, half-frame rounding, extra invariants, custom dimension ranges,
 * reserved JSON keys, custom-size aspect matching and the optional pagination total).
 */
import { describe, expect, it } from 'vitest';
import {
  AssetRefSchema,
  DEFAULT_RESOURCE_LIMITS,
  DirectorArtifactsSchema,
  ILL_FORMED_TEXT_MESSAGE,
  JSON_LIMITS,
  JsonObjectSchema,
  JsonValueSchema,
  ProjectSummaryPageSchema,
  RESERVED_JSON_KEYS,
  ResourceLimitsSchema,
  SafeUriSchema,
  TEMPLATE_CATALOG,
  TimelineSchema,
  VideoRequestSchema,
  allocateFrames,
  checkTimelineLimits,
  checkVideoRequestLimits,
  dimensionsMatchAspectRatio,
  getTemplate,
  getTemplateAssetRefProps,
  isWellFormedText,
  resolveDimensions,
  secondsToFrames,
  toWellFormedText,
  utf8ByteLength,
  validateTemplateProps,
  type JsonObject,
  type JsonValue,
  type ResourceLimits,
  type Timeline,
  type TemplatePropsContext,
} from '../src/index';
import { clip, firstText } from '../src/templates/helpers';
import { ASSETS, buildDirectorArtifacts, buildValidTimeline, buildVideoRequest, buildVideoRequestInput } from './fixtures';
import { expectIssueAt, expectSuccess } from './helpers';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const nativeIsWellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();
const SAMPLE: TemplatePropsContext = { title: 'Q', text: 'Quote text', bullets: [], palette: ['#000000', '#FFFFFF'], brandName: null };

// ---------------------------------------------------------------------------------------------
// 1. allocateFrames overflow
// ---------------------------------------------------------------------------------------------

describe('allocateFrames with extreme weights', () => {
  it('terminates and stays exact for [1e308, 1] (used to loop forever)', () => {
    expect(allocateFrames([1e308, 1], 10)).toEqual([9, 1]);
    expect(allocateFrames([1e306, 1], 1000)).toEqual([999, 1]);
  });

  it('does not return NaN for [1e308, 1e308]', () => {
    expect(allocateFrames([1e308, 1e308], 10)).toEqual([5, 5]);
    expect(allocateFrames([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], 10)).toEqual([4, 3, 3]);
  });

  it('handles denormal and mixed-magnitude weights', () => {
    expect(allocateFrames([5e-324, 5e-324], 10)).toEqual([5, 5]);
    expect(allocateFrames([5e-324, 1], 10)).toEqual([1, 9]);
    expect(allocateFrames([1e308, 5e-324], 10, 0)).toEqual([10, 0]);
  });

  it('always returns safe integers >= min summing exactly to the total (seeded, magnitudes 1e-300..1e300)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let c = 0; c < 400; c++) {
      const n = 1 + Math.floor(rnd() * 12);
      const weights = Array.from({ length: n }, () => 10 ** (rnd() * 600 - 300));
      const minFrames = Math.floor(rnd() * 4);
      const totalFrames = n * minFrames + Math.floor(rnd() * 5000);
      const out = allocateFrames(weights, totalFrames, minFrames);
      expect(out).toHaveLength(n);
      expect(out.every((v) => Number.isSafeInteger(v) && v >= minFrames)).toBe(true);
      expect(sum(out)).toBe(totalFrames);
    }
  });

  it('rejects totals that are not safe integers', () => {
    expect(() => allocateFrames([1, 2], 2 ** 53)).toThrow(RangeError);
    expect(() => allocateFrames([1, 2], 1e308)).toThrow(RangeError);
    expect(() => allocateFrames([1, 2], 10, 2 ** 53)).toThrow(RangeError);
    expect(() => allocateFrames([Number.POSITIVE_INFINITY, 1], 10)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. clip() and well-formed text
// ---------------------------------------------------------------------------------------------

describe('well-formed text helpers', () => {
  it('isWellFormedText / toWellFormedText match the native String methods', () => {
    const samples = ['', 'abc', '🚀', 'a\uD83D', '\uDE80b', 'x\uDE80\uD83Dy', '🚀\uD83D', 'é€'];
    for (const s of samples) {
      expect(isWellFormedText(s), JSON.stringify(s)).toBe(nativeIsWellFormed(s));
      expect(nativeIsWellFormed(toWellFormedText(s))).toBe(true);
    }
    expect(toWellFormedText('a\uD83Db')).toBe('a\uFFFDb');
  });
});

describe('clip() never cuts surrogate pairs', () => {
  it('cuts on code-point boundaries and still fits max code units', () => {
    const out = clip('🚀'.repeat(200), 120);
    expect(isWellFormedText(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
    expect(clip('a🚀b', 3)).toBe('a…');
    expect(clip('🚀🚀', 2)).toBe('…');
    expect(clip('🚀x', 1)).toBe('');
    expect(clip('abc', 1)).toBe('a');
  });

  it('drops a trailing zero-width joiner and repairs lone surrogates in the input', () => {
    expect(clip('👩‍👩‍👧‍👦 family', 4)).toBe('👩…');
    expect(clip('a\uD83Db', 10)).toBe('a\uFFFDb');
    expect(isWellFormedText(clip('x\uDE80'.repeat(50), 20))).toBe(true);
  });

  it('firstText falls back when nothing fits', () => {
    expect(firstText(['🚀'], 'fb', 1)).toBe('f');
  });

  it('every catalog template builds well-formed, valid props from emoji-heavy context', () => {
    const ctx: TemplatePropsContext = {
      title: '🚀'.repeat(200),
      text: '👩‍👩‍👧‍👦'.repeat(300),
      bullets: Array.from({ length: 50 }, (_, i) => '😀'.repeat(i * 7)),
      palette: ['#FFFFFF', '#FFFFFF'],
      brandName: '🏳️‍🌈'.repeat(100),
    };
    for (const template of TEMPLATE_CATALOG) {
      const props = template.buildProps(ctx);
      const result = validateTemplateProps(template.id, props);
      expect(result.success, `${template.id}: ${result.success ? '' : result.issues.join('; ')}`).toBe(true);
      expect(nativeIsWellFormed(JSON.stringify(props))).toBe(true);
    }
  });
});

describe('ill-formed strings are rejected with a clear issue', () => {
  it('JsonValueSchema / JsonObjectSchema (template props)', () => {
    expectIssueAt(JsonObjectSchema.safeParse({ a: ['ok', 'bad\uD83D'] }), ['a', 1], /well-formed UTF-16/);
    expectIssueAt(JsonValueSchema.safeParse('\uDE80'), [], /lone surrogate/);
    const result = validateTemplateProps('quote', { ...getTemplate('quote')?.buildProps(SAMPLE), quote: 'x\uD83D' });
    expect(result.success).toBe(false);
  });

  it('TimelineSchema (invariant 10) reports exact paths, props once', () => {
    const t = buildValidTimeline();
    t.title = 'Broken \uD83D';
    const caption = t.tracks[1];
    if (caption?.kind !== 'caption' || !caption.items[0]) throw new Error('fixture');
    caption.items[0].text = '\uDE80 text';
    const result = TimelineSchema.safeParse(t);
    expectIssueAt(result, ['title'], /well-formed/);
    expectIssueAt(result, ['tracks', 1, 'items', 0, 'text'], /well-formed/);

    const p = buildValidTimeline();
    const scene = p.scenes[0];
    if (scene?.content.engine !== 'motion2d') throw new Error('fixture');
    scene.content.props = { ...scene.content.props, headline: 'x\uD83D' };
    const propsResult = TimelineSchema.safeParse(p);
    expectIssueAt(propsResult, ['scenes', 0, 'content', 'props', 'headline'], /well-formed/);
    if (!propsResult.success) {
      const at = propsResult.error.issues.filter((i) => i.path.join('.') === 'scenes.0.content.props.headline');
      expect(at).toHaveLength(1);
    }
  });

  it('VideoRequestSchema and DirectorArtifactsSchema', () => {
    expectIssueAt(VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), prompt: 'Launch 🚀\uD83D' }), ['prompt'], /well-formed/);
    const artifacts = buildDirectorArtifacts();
    artifacts.brief.title = 'T\uD83D';
    expectIssueAt(DirectorArtifactsSchema.safeParse(artifacts), ['brief', 'title'], /well-formed/);
    expect(ILL_FORMED_TEXT_MESSAGE).toMatch(/lone surrogate/);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Blank title / prompt
// ---------------------------------------------------------------------------------------------

describe('VideoRequestSchema rejects blank title / prompt', () => {
  it.each([
    ['title', '   '],
    ['title', '\n\t'],
    ['title', '\u200B'],
    ['prompt', ' \n '],
    ['prompt', '\u3000\u200B'],
  ])('rejects %s %j', (field, value) => {
    expectIssueAt(VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), [field]: value }), [field]);
  });

  it('trims title and prompt', () => {
    const parsed = VideoRequestSchema.parse({ ...buildVideoRequestInput(), title: '  Launch  ', prompt: '\n A promo. \n' });
    expect(parsed.title).toBe('Launch');
    expect(parsed.prompt).toBe('A promo.');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Timeline size limits + JSON node budget
// ---------------------------------------------------------------------------------------------

const CORE_LIMITS: ResourceLimits = {
  maxDurationSeconds: 7200,
  maxWidth: 3840,
  maxHeight: 3840,
  maxFps: 60,
  maxScenes: 2000,
  maxChapters: 200,
  maxTracks: 50,
  maxAssets: 500,
  maxPromptChars: 20000,
};

function withCaptionItems(t: Timeline, count: number): Timeline {
  const caption = t.tracks[1];
  if (caption?.kind !== 'caption') throw new Error('fixture');
  caption.items = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, startFrame: 0, durationInFrames: 1, text: 'w' }));
  return t;
}

describe('timeline size limits', () => {
  it('ResourceLimitsSchema accepts the size limits as optional positive ints', () => {
    expect(ResourceLimitsSchema.safeParse(CORE_LIMITS).success).toBe(true);
    expect(ResourceLimitsSchema.safeParse({ ...CORE_LIMITS, maxTrackItems: 10, maxLayers: 5, maxTimelineBytes: 1 }).success).toBe(true);
    expect(ResourceLimitsSchema.safeParse({ ...CORE_LIMITS, maxTrackItems: 0 }).success).toBe(false);
    expect(ResourceLimitsSchema.safeParse({ ...CORE_LIMITS, maxTimelineBytes: 1.5 }).success).toBe(false);
  });

  it('reports MAX_TRACK_ITEMS, MAX_LAYERS and MAX_TIMELINE_BYTES when configured', () => {
    const t = buildValidTimeline(); // 2 audio + 2 caption + 2 overlay + 1 video items; 3 + 1 layers
    const exact = checkTimelineLimits(t, { ...CORE_LIMITS, maxTrackItems: 7, maxLayers: 4 });
    expect(exact).toEqual([]);
    const bytes = utf8ByteLength(JSON.stringify(t));
    const violations = checkTimelineLimits(t, { ...CORE_LIMITS, maxTrackItems: 6, maxLayers: 3, maxTimelineBytes: 1000 });
    const byCode = Object.fromEntries(violations.map((v) => [v.code, v]));
    expect(byCode.MAX_TRACK_ITEMS).toMatchObject({ limit: 6, actual: 7 });
    expect(byCode.MAX_LAYERS).toMatchObject({ limit: 3, actual: 4 });
    expect(byCode.MAX_TIMELINE_BYTES).toMatchObject({ limit: 1000, actual: bytes });
  });

  it('falls back to DEFAULT_RESOURCE_LIMITS when a size limit is absent', () => {
    const t = withCaptionItems(buildValidTimeline(), DEFAULT_RESOURCE_LIMITS.maxTrackItems);
    expect(checkTimelineLimits(t, CORE_LIMITS).map((v) => v.code)).toEqual(['MAX_TRACK_ITEMS']);
    const huge = buildValidTimeline();
    huge.title = 'x'.repeat(200);
    const scene = huge.scenes[0];
    if (scene?.content.engine !== 'motion2d') throw new Error('fixture');
    scene.notes = '€'.repeat(2000);
    const bytes = utf8ByteLength(JSON.stringify(huge));
    expect(checkTimelineLimits(huge, { ...CORE_LIMITS, maxTimelineBytes: bytes })).toEqual([]);
    expect(checkTimelineLimits(huge, { ...CORE_LIMITS, maxTimelineBytes: bytes - 1 }).map((v) => v.code)).toEqual([
      'MAX_TIMELINE_BYTES',
    ]);
  });

  it('utf8ByteLength counts UTF-8 bytes', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('🚀')).toBe(4);
    expect(utf8ByteLength('\uD800')).toBe(3);
    const sample = 'aé€🚀 mixed ✨ text';
    expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
  });
});

describe('JSON node budget', () => {
  const grid = (rows: number, cols: number): JsonValue => Array.from({ length: rows }, () => new Array<number>(cols).fill(1));

  it(`accepts up to ${JSON_LIMITS.maxNodes} nodes and rejects more, with a clear root issue`, () => {
    expect(JSON_LIMITS.maxNodes).toBe(10_000);
    // 1 root + 99 rows + 99 × 100 cells = 10 000 nodes
    expectSuccess(JsonValueSchema.safeParse(grid(99, 100)));
    expectIssueAt(JsonValueSchema.safeParse(grid(100, 100)), [], /more than 10000 nodes/);
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, new Array<number>(50).fill(0)]));
    expectIssueAt(JsonObjectSchema.safeParse(wide), [], /too large/);
  });

  it('rejects the 500×500 blow-up quickly', () => {
    const blob = Array.from({ length: 500 }, () => Array.from({ length: 500 }, () => 'x'.repeat(100)));
    const t0 = Date.now();
    expect(JsonObjectSchema.safeParse({ blob }).success).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. SafeUri bypasses + normalized output
// ---------------------------------------------------------------------------------------------

describe('SafeUriSchema hardening', () => {
  it.each([
    'https://@evil.com/x',
    'https:evil.com',
    'https:/evil.com',
    'https:\\\\evil.com',
    'https://trusted.com\\@evil.com/',
    'https://user:@h.com/',
    'https://:@h.com',
    'https://[::1]/admin',
    'https://[::ffff:127.0.0.1]/',
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://0x7f.1/',
    'https://2130706433/',
    'https://localhost/',
    'https://LOCALHOST:8443/',
    'https://app.localhost/',
    'https://printer.local/',
    'https://metadata.google.internal/',
    'https://router.home.arpa/',
    'https://intranet/',
    'https://example.com./',
    'https://exa\u200Bmple.com/',
    'https://example.com/\u202Egnp.exe',
    'https://example.com/\uFEFFa',
    'https://example.com/./a',
    'https://example.com/a/../b',
    'https://example.com/%2E%2E/b',
    'https://example.com/a/..%2f..%2fetc',
    'https://h.com/%00',
    'https://h.com/%1f',
    'asset://img-1/../../../etc/passwd',
    'asset://img-1/%2e%2e/%2e%2e/etc/passwd',
    'asset://%2e%2e/x',
    'asset://..',
    'asset:///img-1',
    'asset://[::1]',
    'asset://img-1:80',
    'asset://user@img',
    'asset://img-1?x=1',
    'asset://img-1#frag',
    'asset://img-1/.hidden',
    'asset://img-1//double',
    'asset://img-1/a%20b',
    'asset://-bad',
  ])('rejects %j', (uri) => {
    expect(SafeUriSchema.safeParse(uri).success).toBe(false);
  });

  it.each([
    ['asset://img-1', 'asset://img-1'],
    ['ASSET://img-1', 'asset://img-1'],
    ['asset://abc123/variant.png', 'asset://abc123/variant.png'],
    ['asset://abc_123/v-1/thumb.webp', 'asset://abc_123/v-1/thumb.webp'],
    ['https://cdn.example.com/a.mp4', 'https://cdn.example.com/a.mp4'],
    ['HTTPS://EXAMPLE.COM/upper', 'https://example.com/upper'],
    ['https://cdn.example.com', 'https://cdn.example.com/'],
    ['https://example.com:443/x', 'https://example.com/x'],
    ['https://example.com:8443/x?query=1#frag', 'https://example.com:8443/x?query=1#frag'],
    ['https://example.com/café.png', 'https://example.com/caf%C3%A9.png'],
    ['https://\u0435xample.com/', 'https://xn--xample-2of.com/'],
    ['https://my_bucket.s3.amazonaws.com/a', 'https://my_bucket.s3.amazonaws.com/a'],
  ])('accepts %j and outputs the normalized href', (uri, href) => {
    const result = SafeUriSchema.safeParse(uri);
    expectSuccess(result);
    if (result.success) expect(result.data).toBe(href);
  });

  it('normalizes AssetRef.uri', () => {
    const asset = AssetRefSchema.parse({ id: 'a1', kind: 'image', uri: 'HTTPS://CDN.Example.com', mimeType: 'image/png', source: 'stock' });
    expect(asset.uri).toBe('https://cdn.example.com/');
  });

  it('gives specific messages', () => {
    const msg = (uri: string) => {
      const r = SafeUriSchema.safeParse(uri);
      return r.success ? '' : (r.error.issues[0]?.message ?? '');
    };
    expect(msg('https:evil.com')).toMatch(/must start with "https:\/\/" or "asset:\/\/"/);
    expect(msg('https://127.0.0.1/')).toMatch(/IP address/);
    expect(msg('https://localhost/')).toMatch(/fully-qualified|local/);
    expect(msg('https://svc.internal/')).toMatch(/local or internal/);
    expect(msg('asset://img-1/../x')).toMatch(/dot segments/);
    expect(msg('https://a.com\\@b.com')).toMatch(/backslash/);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. secondsToFrames half-frame rounding
// ---------------------------------------------------------------------------------------------

describe('secondsToFrames rounds exact half frames up', () => {
  it('fixes the float cases found by the probe', () => {
    expect(secondsToFrames(0.29, 50)).toBe(15);
    expect(secondsToFrames(0.57, 50)).toBe(29);
    expect(secondsToFrames(0.58, 25)).toBe(15);
    expect(secondsToFrames(1.025, 60)).toBe(62);
    expect(secondsToFrames(0.5, 1)).toBe(1);
  });

  it('matches exact integer rounding for every millisecond up to 20 s at common frame rates', () => {
    let mismatches = 0;
    for (let ms = 1; ms <= 20000; ms++) {
      for (const fps of [23, 24, 25, 29, 30, 48, 50, 59, 60, 120, 240]) {
        const exact = Math.floor((2 * ms * fps + 1000) / 2000);
        if (secondsToFrames(ms / 1000, fps) !== exact) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. New invariants
// ---------------------------------------------------------------------------------------------

function sceneContent(t: Timeline, index: number) {
  const scene = t.scenes[index];
  if (!scene) throw new Error('fixture');
  return scene.content;
}

describe('screen zoom regions lie within the scene', () => {
  it('reports regions that start or end outside the scene', () => {
    const t = buildValidTimeline();
    const content = sceneContent(t, 5);
    if (content.engine !== 'screen') throw new Error('fixture');
    content.zoomRegions = [
      { startFrame: 0, durationInFrames: 50, x: 0, y: 0, width: 1, height: 1 },
      { startFrame: 40, durationInFrames: 11, x: 0, y: 0, width: 1, height: 1 },
      { startFrame: 100000, durationInFrames: 99999, x: 0, y: 0, width: 1, height: 1 },
    ];
    const result = TimelineSchema.safeParse(t);
    expectIssueAt(result, ['scenes', 5, 'content', 'zoomRegions', 1, 'durationInFrames'], /beyond the scene duration 50/);
    expectIssueAt(result, ['scenes', 5, 'content', 'zoomRegions', 2, 'startFrame'], /outside the scene/);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'scenes.5.content.zoomRegions.0.durationInFrames')).toBe(false);
    }
  });
});

describe('trimStartFrame must fall inside the source when its duration is known', () => {
  it('footage, screen, video and audio items', () => {
    const t = buildValidTimeline(); // vid-1 has durationInFrames 900
    const footage = sceneContent(t, 2);
    const screen = sceneContent(t, 5);
    if (footage.engine !== 'footage' || screen.engine !== 'screen') throw new Error('fixture');
    footage.trimStartFrame = 900;
    screen.trimStartFrame = 1_000_000;
    const audioAsset = t.assets.find((a) => a.id === ASSETS.audio);
    if (audioAsset) audioAsset.durationInFrames = 100;
    const [audio, , , video] = t.tracks;
    if (audio?.kind !== 'audio' || video?.kind !== 'video' || !audio.items[0] || !video.items[0]) throw new Error('fixture');
    audio.items[0].trimStartFrame = 100;
    video.items[0].trimStartFrame = 5000;
    const result = TimelineSchema.safeParse(t);
    expectIssueAt(result, ['scenes', 2, 'content', 'trimStartFrame'], /must be < the duration of asset "vid-1" \(900 frames\)/);
    expectIssueAt(result, ['scenes', 5, 'content', 'trimStartFrame']);
    expectIssueAt(result, ['tracks', 0, 'items', 0, 'trimStartFrame']);
    expectIssueAt(result, ['tracks', 3, 'items', 0, 'trimStartFrame']);
  });

  it('is not checked when the asset has no durationInFrames, and 899 is fine', () => {
    const t = buildValidTimeline();
    const footage = sceneContent(t, 2);
    if (footage.engine !== 'footage') throw new Error('fixture');
    footage.trimStartFrame = 899;
    const [audio] = t.tracks;
    if (audio?.kind !== 'audio' || !audio.items[0]) throw new Error('fixture');
    audio.items[0].trimStartFrame = 1_000_000; // aud-1 has no durationInFrames
    expectSuccess(TimelineSchema.safeParse(t));
  });
});

describe('template asset-reference props', () => {
  function withSplitFeature(t: Timeline, imageAssetId: string | null, template = 'split-feature'): Timeline {
    const scene = t.scenes[0];
    const base = getTemplate('split-feature')?.buildProps(SAMPLE);
    if (scene?.content.engine !== 'motion2d' || !base) throw new Error('fixture');
    scene.content.template = template;
    scene.content.props = { ...(base as JsonObject), imageAssetId };
    return t;
  }

  it('derives asset-ref props from the catalog', () => {
    expect(getTemplateAssetRefProps('split-feature')).toEqual([{ prop: 'imageAssetId', kind: 'image' }]);
    expect(getTemplateAssetRefProps('title-card')).toEqual([]);
    expect(getTemplateAssetRefProps('future-template')).toEqual([]);
  });

  it('split-feature imageAssetId must name an existing image asset', () => {
    expectIssueAt(
      TimelineSchema.safeParse(withSplitFeature(buildValidTimeline(), 'ghost')),
      ['scenes', 0, 'content', 'props', 'imageAssetId'],
      /Unknown asset "ghost"/,
    );
    expectIssueAt(
      TimelineSchema.safeParse(withSplitFeature(buildValidTimeline(), ASSETS.video)),
      ['scenes', 0, 'content', 'props', 'imageAssetId'],
      /must be of kind "image"/,
    );
    expectSuccess(TimelineSchema.safeParse(withSplitFeature(buildValidTimeline(), ASSETS.image)));
    expectSuccess(TimelineSchema.safeParse(withSplitFeature(buildValidTimeline(), null)));
    // Unknown (future) templates are never inspected.
    expectSuccess(TimelineSchema.safeParse(withSplitFeature(buildValidTimeline(), 'ghost', 'future-split')));
  });

  it('is also checked on overlay motion2d content', () => {
    const t = buildValidTimeline();
    const overlay = t.tracks[2];
    const base = getTemplate('split-feature')?.buildProps(SAMPLE);
    if (overlay?.kind !== 'overlay' || overlay.items[0]?.content.engine !== 'motion2d' || !base) throw new Error('fixture');
    overlay.items[0].content.template = 'split-feature';
    overlay.items[0].content.props = { ...(base as JsonObject), imageAssetId: 'ghost' };
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', 2, 'items', 0, 'content', 'props', 'imageAssetId']);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. resolveDimensions range
// ---------------------------------------------------------------------------------------------

describe('resolveDimensions range-checks custom sizes', () => {
  const custom = (customWidth: number, customHeight: number) =>
    resolveDimensions({ aspectRatio: 'custom', resolution: 'custom', customWidth, customHeight });

  it('throws RangeError outside [16, 8192] after even rounding', () => {
    expect(() => custom(99999, 8193)).toThrow(RangeError);
    expect(() => custom(1, 1)).toThrow(RangeError);
    expect(() => custom(0.4, 3)).toThrow(RangeError);
    expect(() => custom(8193, 1080)).toThrow(/outside \[16, 8192\]/);
    expect(custom(15, 8191)).toEqual({ width: 16, height: 8192 });
    expect(custom(17, 33)).toEqual({ width: 18, height: 34 });
  });

  it('checkVideoRequestLimits reports INVALID_DIMENSIONS', () => {
    const request = { ...buildVideoRequest(), aspectRatio: 'custom' as const, customWidth: 99999, customHeight: 1080 };
    expect(checkVideoRequestLimits(request, DEFAULT_RESOURCE_LIMITS).map((v) => v.code)).toContain('INVALID_DIMENSIONS');
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Reserved JSON keys
// ---------------------------------------------------------------------------------------------

describe('reserved JSON keys', () => {
  it('rejects "__proto__" explicitly instead of silently dropping it', () => {
    const input: unknown = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}');
    expectIssueAt(JsonObjectSchema.safeParse(input), ['__proto__'], /not allowed/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(RESERVED_JSON_KEYS)('rejects %j at any depth', (key) => {
    const nested: unknown = JSON.parse(`{"a": [{"${key}": 1}]}`);
    expectIssueAt(JsonObjectSchema.safeParse(nested), ['a', 0, key], /reserved/);
    expectIssueAt(JsonValueSchema.safeParse(nested), ['a', 0, key]);
  });

  it('still accepts look-alike keys', () => {
    expectSuccess(JsonObjectSchema.safeParse({ proto: 1, Constructor: 2, prototypes: 3, __proto: 4 }));
  });
});

// ---------------------------------------------------------------------------------------------
// Orchestrator follow-ups: custom size vs aspect ratio, pagination total
// ---------------------------------------------------------------------------------------------

describe('custom resolution must match a preset aspect ratio', () => {
  const req = (aspectRatio: '16:9' | '9:16' | '1:1' | '4:5' | 'custom', customWidth: number, customHeight: number) =>
    VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), aspectRatio, resolution: 'custom', customWidth, customHeight });

  it('accepts sizes matching the ratio up to ±1 px per side', () => {
    expectSuccess(req('16:9', 1920, 1080));
    expectSuccess(req('16:9', 854, 480));
    expectSuccess(req('16:9', 852, 480));
    expectSuccess(req('9:16', 1080, 1920));
    expectSuccess(req('4:5', 1080, 1350));
    expectSuccess(req('1:1', 1080, 1082));
  });

  it('rejects mismatching sizes with an issue on customWidth', () => {
    expectIssueAt(req('16:9', 1920, 1000), ['customWidth'], /does not match aspect ratio 16:9 \(e\.g\. 1920×1080/);
    expectIssueAt(req('16:9', 850, 480), ['customWidth']);
    expectIssueAt(req('1:1', 1080, 1084), ['customWidth']);
    expectIssueAt(req('9:16', 1920, 1080), ['customWidth']);
  });

  it('with aspectRatio "custom" any size is allowed and the resolution preset is ignored', () => {
    expectSuccess(req('custom', 1000, 300));
    const parsed = VideoRequestSchema.parse({
      ...buildVideoRequestInput(),
      aspectRatio: 'custom',
      resolution: '2160p',
      customWidth: 1000,
      customHeight: 300,
    });
    expect(resolveDimensions(parsed)).toEqual({ width: 1000, height: 300 });
  });

  it('dimensionsMatchAspectRatio', () => {
    expect(dimensionsMatchAspectRatio(1280, 720, '16:9')).toBe(true);
    expect(dimensionsMatchAspectRatio(1281, 721, '16:9')).toBe(true);
    expect(dimensionsMatchAspectRatio(1280, 722, '16:9')).toBe(false);
    expect(dimensionsMatchAspectRatio(5, 7, 'custom')).toBe(true);
  });
});

describe('paginated total', () => {
  const page = { items: [], nextCursor: null };
  it('is optional and a non-negative integer', () => {
    expectSuccess(ProjectSummaryPageSchema.safeParse(page));
    expect(ProjectSummaryPageSchema.parse({ ...page, total: 3 }).total).toBe(3);
    expect(ProjectSummaryPageSchema.safeParse({ ...page, total: 0 }).success).toBe(true);
    expect(ProjectSummaryPageSchema.safeParse({ ...page, total: -1 }).success).toBe(false);
    expect(ProjectSummaryPageSchema.safeParse({ ...page, total: 1.5 }).success).toBe(false);
  });
});
