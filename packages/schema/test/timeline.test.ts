import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CURRENT_TIMELINE_VERSION,
  TimelineBaseSchema,
  TimelineMigrationError,
  TimelineSchema,
  TransitionSchema,
  parseTimeline,
  safeParseTimeline,
  type Scene,
  type Timeline,
} from '../src/index';
import { ASSETS, buildMinimalTimeline, buildValidTimeline } from './fixtures';
import { expectIssueAt, expectSuccess } from './helpers';

function scene(t: Timeline, index: number): Scene {
  const s = t.scenes[index];
  if (!s) throw new Error(`no scene ${index}`);
  return s;
}

function track<K extends Timeline['tracks'][number]['kind']>(
  t: Timeline,
  kind: K,
): Extract<Timeline['tracks'][number], { kind: K }> {
  const found = t.tracks.find((tr): tr is Extract<Timeline['tracks'][number], { kind: K }> => tr.kind === kind);
  if (!found) throw new Error(`no ${kind} track`);
  return found;
}

describe('TimelineSchema — valid fixtures', () => {
  it('accepts the rich fixture covering every engine and track kind', () => {
    const t = buildValidTimeline();
    expectSuccess(TimelineSchema.safeParse(t));
    expect(new Set(t.scenes.map((s) => s.content.engine))).toEqual(
      new Set(['motion2d', 'three', 'footage', 'image', 'generated', 'screen']),
    );
    expect(new Set(t.tracks.map((tr) => tr.kind))).toEqual(new Set(['audio', 'caption', 'overlay', 'video']));
  });

  it('accepts the minimal fixture', () => {
    expectSuccess(TimelineSchema.safeParse(buildMinimalTimeline()));
    expectSuccess(TimelineSchema.safeParse(buildMinimalTimeline(1)));
  });

  it('round-trips through JSON unchanged', () => {
    const t = buildValidTimeline();
    expect(TimelineSchema.parse(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('defaults motion2d layers to []', () => {
    const t = buildMinimalTimeline() as unknown as { scenes: { content: Record<string, unknown> }[] };
    delete t.scenes[0]?.content.layers;
    const parsed = TimelineSchema.parse(t);
    const content = parsed.scenes[0]?.content;
    expect(content?.engine === 'motion2d' ? content.layers : null).toEqual([]);
  });

  it('exposes CURRENT_TIMELINE_VERSION = 1 and rejects other versions structurally', () => {
    expect(CURRENT_TIMELINE_VERSION).toBe(1);
    const t = { ...buildMinimalTimeline(), schemaVersion: 2 };
    expectIssueAt(TimelineSchema.safeParse(t), ['schemaVersion']);
  });

  it('does not run invariants on structurally invalid input (no crash)', () => {
    const result = TimelineSchema.safeParse({ ...buildMinimalTimeline(), scenes: 'nope' });
    expectIssueAt(result, ['scenes']);
    expect(TimelineSchema.safeParse(null).success).toBe(false);
  });

  it('requires at least one chapter and one scene', () => {
    expectIssueAt(TimelineSchema.safeParse({ ...buildMinimalTimeline(), chapters: [] }), ['chapters']);
    expectIssueAt(TimelineSchema.safeParse({ ...buildMinimalTimeline(), scenes: [] }), ['scenes']);
  });

  it('TimelineBaseSchema skips cross-field invariants', () => {
    const t = buildValidTimeline();
    scene(t, 1).startFrame = 61;
    expectSuccess(TimelineBaseSchema.safeParse(t));
    expect(TimelineSchema.safeParse(t).success).toBe(false);
  });
});

describe('TimelineSchema — invariant 1: scenes sorted, contiguous, [0, duration]', () => {
  it('first scene must start at 0', () => {
    const t = buildMinimalTimeline();
    scene(t, 0).startFrame = 5;
    scene(t, 0).durationInFrames = 85;
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'startFrame'], /start at frame 0/);
  });

  it('detects a gap between scenes', () => {
    const t = buildValidTimeline();
    scene(t, 2).startFrame = 91;
    scene(t, 2).durationInFrames = 59;
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 2, 'startFrame'], /contiguous/);
  });

  it('detects unsorted scenes', () => {
    const t = buildValidTimeline();
    const [a, b] = [scene(t, 4), scene(t, 5)];
    t.scenes[4] = b;
    t.scenes[5] = a;
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 4, 'startFrame']);
  });

  it('last scene must end exactly at durationInFrames', () => {
    const t = buildValidTimeline();
    scene(t, 5).durationInFrames = 49;
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 5, 'durationInFrames'], /end exactly/);
  });
});

describe('TimelineSchema — invariant 2: chapters', () => {
  it('chapters must be contiguous', () => {
    const t = buildValidTimeline();
    const ch = t.chapters[1];
    if (!ch) throw new Error('fixture');
    ch.startFrame = 151;
    ch.durationInFrames = 149;
    expectIssueAt(TimelineSchema.safeParse(t), ['chapters', 1, 'startFrame']);
  });

  it('last chapter must end at durationInFrames', () => {
    const t = buildValidTimeline();
    const ch = t.chapters[1];
    if (!ch) throw new Error('fixture');
    ch.durationInFrames = 140;
    expectIssueAt(TimelineSchema.safeParse(t), ['chapters', 1, 'durationInFrames']);
  });

  it('every scene.chapterId must exist', () => {
    const t = buildValidTimeline();
    scene(t, 3).chapterId = 'ch-404';
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 3, 'chapterId'], /Unknown chapter/);
  });

  it('each scene must lie fully inside its chapter', () => {
    const t = buildValidTimeline();
    scene(t, 3).chapterId = 'ch-1'; // s-4 [150,210) is outside ch-1 [0,150)
    const result = TimelineSchema.safeParse(t);
    expectIssueAt(result, ['scenes', 3, 'durationInFrames'], /ends after its chapter/);
  });

  it('scene order never goes back to an earlier chapter', () => {
    const t = buildValidTimeline();
    // Make chapters [0,90) [90,300) and assign s-3 [90,150) to ch-2, s-4 back to ch-1.
    t.chapters = [
      { id: 'ch-1', title: 'A', startFrame: 0, durationInFrames: 90 },
      { id: 'ch-2', title: 'B', startFrame: 90, durationInFrames: 210 },
    ];
    scene(t, 2).chapterId = 'ch-2';
    scene(t, 3).chapterId = 'ch-1';
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 3, 'chapterId'], /earlier chapter/);
  });
});

describe('TimelineSchema — invariant 3: global id namespace', () => {
  it('rejects a scene id reused as a chapter id', () => {
    const t = buildValidTimeline();
    scene(t, 0).id = 'ch-1';
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'id'], /Duplicate id/);
  });

  it('rejects duplicate asset ids', () => {
    const t = buildValidTimeline();
    const a = t.assets[1];
    if (!a) throw new Error('fixture');
    a.id = ASSETS.image;
    a.kind = 'image';
    expectIssueAt(TimelineSchema.safeParse(t), ['assets', 1, 'id']);
  });

  it('rejects a track item id equal to a track id', () => {
    const t = buildValidTimeline();
    const item = track(t, 'caption').items[1];
    if (!item) throw new Error('fixture');
    item.id = 't-vo';
    const ti = t.tracks.findIndex((tr) => tr.kind === 'caption');
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', ti, 'items', 1, 'id']);
  });

  it('rejects a layer id that collides with a scene id', () => {
    const t = buildValidTimeline();
    const content = scene(t, 0).content;
    if (content.engine !== 'motion2d') throw new Error('fixture');
    const layer = content.layers[1];
    if (!layer) throw new Error('fixture');
    layer.id = 's-3';
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'content', 'layers', 1, 'id']);
  });

  it('rejects overlay layer ids that collide with scene layers', () => {
    const t = buildValidTimeline();
    const ov = track(t, 'overlay').items[0];
    if (!ov || ov.content.engine !== 'motion2d') throw new Error('fixture');
    const layer = ov.content.layers[0];
    if (!layer) throw new Error('fixture');
    layer.id = 'layer-text';
    const ti = t.tracks.findIndex((tr) => tr.kind === 'overlay');
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', ti, 'items', 0, 'content', 'layers', 0, 'id']);
  });
});

describe('TimelineSchema — invariant 4: asset references', () => {
  it('rejects unknown asset ids', () => {
    const t = buildValidTimeline();
    const content = scene(t, 2).content;
    if (content.engine !== 'footage') throw new Error('fixture');
    content.assetId = 'missing-asset';
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 2, 'content', 'assetId'], /Unknown asset/);
  });

  const kindCases: { name: string; mutate: (t: Timeline) => void; path: (t: Timeline) => (string | number)[] }[] = [
    {
      name: 'footage needs video',
      mutate: (t) => {
        const c = scene(t, 2).content;
        if (c.engine === 'footage') c.assetId = ASSETS.image;
      },
      path: () => ['scenes', 2, 'content', 'assetId'],
    },
    {
      name: 'screen needs video',
      mutate: (t) => {
        const c = scene(t, 5).content;
        if (c.engine === 'screen') c.assetId = ASSETS.audio;
      },
      path: () => ['scenes', 5, 'content', 'assetId'],
    },
    {
      name: 'image content needs image',
      mutate: (t) => {
        const c = scene(t, 3).content;
        if (c.engine === 'image') c.assetId = ASSETS.video;
      },
      path: () => ['scenes', 3, 'content', 'assetId'],
    },
    {
      name: 'image layer needs image',
      mutate: (t) => {
        const c = scene(t, 0).content;
        const layer = c.engine === 'motion2d' ? c.layers[2] : undefined;
        if (layer?.type === 'image') layer.assetId = ASSETS.model;
      },
      path: () => ['scenes', 0, 'content', 'layers', 2, 'assetId'],
    },
    {
      name: 'brand logo needs image',
      mutate: (t) => {
        if (t.brand) t.brand.logoAssetId = ASSETS.video;
      },
      path: () => ['brand', 'logoAssetId'],
    },
    {
      name: 'audio item needs audio',
      mutate: (t) => {
        const item = track(t, 'audio').items[0];
        if (item) item.assetId = ASSETS.video;
      },
      path: (t) => ['tracks', t.tracks.findIndex((tr) => tr.kind === 'audio'), 'items', 0, 'assetId'],
    },
    {
      name: 'video clip needs video',
      mutate: (t) => {
        const item = track(t, 'video').items[0];
        if (item) item.assetId = ASSETS.image;
      },
      path: (t) => ['tracks', t.tracks.findIndex((tr) => tr.kind === 'video'), 'items', 0, 'assetId'],
    },
    {
      name: 'overlay image needs image',
      mutate: (t) => {
        const item = track(t, 'overlay').items[1];
        if (item?.content.engine === 'image') item.content.assetId = ASSETS.audio;
      },
      path: (t) => ['tracks', t.tracks.findIndex((tr) => tr.kind === 'overlay'), 'items', 1, 'content', 'assetId'],
    },
    {
      name: 'three.modelAssetId needs model3d',
      mutate: (t) => {
        const c = scene(t, 1).content;
        if (c.engine === 'three') c.modelAssetId = ASSETS.image;
      },
      path: () => ['scenes', 1, 'content', 'modelAssetId'],
    },
    {
      name: 'generated assetId needs video',
      mutate: (t) => {
        const c = scene(t, 4).content;
        if (c.engine === 'generated') c.assetId = ASSETS.image;
      },
      path: () => ['scenes', 4, 'content', 'assetId'],
    },
  ];

  for (const c of kindCases) {
    it(`rejects incompatible kind: ${c.name}`, () => {
      const t = buildValidTimeline();
      c.mutate(t);
      expectIssueAt(TimelineSchema.safeParse(t), c.path(t), /must be of kind/);
    });
  }
});

describe('TimelineSchema — invariant 5: track items', () => {
  const capIndex = (t: Timeline) => t.tracks.findIndex((tr) => tr.kind === 'caption');

  it('rejects items ending beyond durationInFrames', () => {
    const t = buildValidTimeline();
    const item = track(t, 'caption').items[1];
    if (!item) throw new Error('fixture');
    item.durationInFrames = 201; // [100, 301)
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', capIndex(t), 'items', 1, 'durationInFrames'], /beyond/);
  });

  it('rejects items starting at/after durationInFrames', () => {
    const t = buildValidTimeline();
    const item = track(t, 'caption').items[1];
    if (!item) throw new Error('fixture');
    item.startFrame = 300;
    item.durationInFrames = 10;
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', capIndex(t), 'items', 1, 'startFrame'], /outside/);
  });

  it('rejects overlapping items in one track', () => {
    const t = buildValidTimeline();
    const item = track(t, 'caption').items[1];
    if (!item) throw new Error('fixture');
    item.startFrame = 99;
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', capIndex(t), 'items', 1, 'startFrame'], /overlaps/);
  });

  it('rejects unsorted items', () => {
    const t = buildValidTimeline();
    const items = track(t, 'caption').items;
    const [a, b] = [items[0], items[1]];
    if (!a || !b) throw new Error('fixture');
    items[0] = b;
    items[1] = a;
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', capIndex(t), 'items', 1, 'startFrame'], /sorted/);
  });

  it('allows items in different tracks to overlap and adjacent items to touch', () => {
    const t = buildValidTimeline();
    expectSuccess(TimelineSchema.safeParse(t)); // cap-1 ends at 100 where cap-2 starts; t-vid overlaps t-cap
  });
});

describe('TimelineSchema — invariant 6: transitions', () => {
  it('rejects a non-cut transitionIn on the first scene', () => {
    const t = buildValidTimeline();
    scene(t, 0).transitionIn = { type: 'fade', durationInFrames: 10, easing: 'linear' };
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'transitionIn'], /first scene/);
  });

  it('allows a cut on the first scene', () => {
    const t = buildValidTimeline();
    scene(t, 0).transitionIn = { type: 'cut', durationInFrames: 0, easing: 'linear' };
    expectSuccess(TimelineSchema.safeParse(t));
  });

  it('rejects a transition longer than the previous scene', () => {
    const t = buildValidTimeline();
    // s-3 (60 frames) after s-2 (30 frames): 31 > min(60, 30)
    scene(t, 2).transitionIn = { type: 'fade', durationInFrames: 31, easing: 'linear' };
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 2, 'transitionIn', 'durationInFrames'], /exceeds/);
  });

  it('rejects a transition longer than the scene itself', () => {
    const t = buildValidTimeline();
    // s-2 (30 frames) after s-1 (60 frames)
    scene(t, 1).transitionIn = { type: 'wipe', durationInFrames: 31, easing: 'linear' };
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 1, 'transitionIn', 'durationInFrames']);
  });

  it('TransitionSchema: cut ⇔ durationInFrames 0', () => {
    expectIssueAt(TransitionSchema.safeParse({ type: 'cut', durationInFrames: 5, easing: 'linear' }), ['durationInFrames']);
    expectIssueAt(TransitionSchema.safeParse({ type: 'fade', durationInFrames: 0, easing: 'linear' }), ['durationInFrames']);
    expectSuccess(TransitionSchema.safeParse({ type: 'dip-to-black', durationInFrames: 8, easing: 'ease-in' }));
    expectIssueAt(TransitionSchema.safeParse({ type: 'fade', durationInFrames: -1, easing: 'linear' }), ['durationInFrames']);
  });
});

describe('TimelineSchema — invariant 7: camera', () => {
  it('rejects keyframes at/after the scene duration', () => {
    const t = buildValidTimeline();
    const s = scene(t, 0);
    if (s.camera?.space !== '2d') throw new Error('fixture');
    const kf = s.camera.keyframes[1];
    if (!kf) throw new Error('fixture');
    kf.frame = 60;
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'camera', 'keyframes', 1, 'frame'], /< scene duration/);
  });

  it('rejects non-increasing keyframes', () => {
    const t = buildValidTimeline();
    const s = scene(t, 0);
    s.camera = {
      space: '2d',
      keyframes: [
        { frame: 10, x: 0, y: 0, zoom: 1, rotation: 0, easing: 'linear' },
        { frame: 10, x: 0, y: 0, zoom: 1.1, rotation: 0, easing: 'linear' },
      ],
    };
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'camera', 'keyframes', 1, 'frame'], /strictly increasing/);
  });

  it('rejects a 3d camera on a non-three scene', () => {
    const t = buildValidTimeline();
    scene(t, 0).camera = {
      space: '3d',
      keyframes: [{ frame: 0, position: [0, 1, 8], target: [0, 0, 0], fov: 50, easing: 'linear' }],
    };
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'camera', 'space'], /not allowed/);
  });

  it('rejects a 2d camera on a three scene', () => {
    const t = buildValidTimeline();
    scene(t, 1).camera = {
      space: '2d',
      keyframes: [{ frame: 0, x: 0, y: 0, zoom: 1, rotation: 0, easing: 'linear' }],
    };
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 1, 'camera', 'space']);
  });
});

describe('TimelineSchema — invariant 8: audio fades and layer bounds', () => {
  it('rejects fadeIn + fadeOut > durationInFrames', () => {
    const t = buildValidTimeline();
    const item = track(t, 'audio').items[0];
    if (!item) throw new Error('fixture');
    item.fadeInFrames = 100;
    item.fadeOutFrames = 51; // 151 > 150
    const ti = t.tracks.findIndex((tr) => tr.kind === 'audio');
    expectIssueAt(TimelineSchema.safeParse(t), ['tracks', ti, 'items', 0, 'fadeOutFrames'], /exceeds/);
  });

  it('accepts fades summing exactly to the item duration', () => {
    const t = buildValidTimeline();
    const item = track(t, 'audio').items[0];
    if (!item) throw new Error('fixture');
    item.fadeInFrames = 75;
    item.fadeOutFrames = 75;
    expectSuccess(TimelineSchema.safeParse(t));
  });

  it('rejects a layer that runs past the scene', () => {
    const t = buildValidTimeline();
    const c = scene(t, 0).content;
    if (c.engine !== 'motion2d') throw new Error('fixture');
    const layer = c.layers[1];
    if (!layer) throw new Error('fixture');
    layer.durationInFrames = 51; // 10 + 51 > 60
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 0, 'content', 'layers', 1, 'durationInFrames'], /beyond/);
  });
});

describe('TimelineSchema — invariant 9: generated scenes', () => {
  it('requires assetId when status is ready', () => {
    const t = buildValidTimeline();
    const c = scene(t, 4).content;
    if (c.engine !== 'generated') throw new Error('fixture');
    delete c.assetId;
    expectIssueAt(TimelineSchema.safeParse(t), ['scenes', 4, 'content', 'assetId'], /ready/);
  });

  it('allows a pending generation without an asset', () => {
    const t = buildValidTimeline();
    const c = scene(t, 4).content;
    if (c.engine !== 'generated') throw new Error('fixture');
    delete c.assetId;
    c.status = 'pending';
    expectSuccess(TimelineSchema.safeParse(t));
  });
});

describe('parseTimeline / safeParseTimeline', () => {
  it('parseTimeline returns the parsed timeline', () => {
    const t = buildValidTimeline();
    expect(parseTimeline(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('parseTimeline throws TimelineMigrationError for a missing version and ZodError for invalid docs', () => {
    const noVersion: Record<string, unknown> = { ...buildMinimalTimeline() };
    delete noVersion.schemaVersion;
    expect(() => parseTimeline(noVersion)).toThrow(TimelineMigrationError);
    const t = buildMinimalTimeline();
    scene(t, 0).durationInFrames = 10;
    expect(() => parseTimeline(t)).toThrow(z.ZodError);
  });

  it('safeParseTimeline reports success and failures without throwing', () => {
    const ok = safeParseTimeline(buildValidTimeline());
    expect(ok.success).toBe(true);

    const newer = safeParseTimeline({ ...buildMinimalTimeline(), schemaVersion: 99 });
    expectIssueAt(newer, ['schemaVersion'], /newer/);

    const missing = safeParseTimeline({ title: 'x' });
    expectIssueAt(missing, ['schemaVersion'], /missing/);

    const notObject = safeParseTimeline('timeline');
    expectIssueAt(notObject, []);

    const t = buildValidTimeline();
    scene(t, 0).startFrame = 1;
    expectIssueAt(safeParseTimeline(t), ['scenes', 0, 'startFrame']);
  });
});
