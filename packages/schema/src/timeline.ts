import { z } from 'zod';
import { AssetRefSchema, type AssetKind, type AssetRef } from './assets';
import { BrandKitSchema } from './brand';
import { ChapterSchema } from './chapter';
import { DurationFramesSchema, IdSchema, IsoDateTimeSchema, LanguageTagSchema } from './common';
import type { Layer2D } from './layers';
import { CURRENT_TIMELINE_VERSION, TimelineMigrationError, migrateTimeline } from './migrations';
import { RenderSettingsSchema } from './render-settings';
import { SceneSchema } from './scene';
import { TrackSchema } from './tracks';

export const TimelineGeneratorSchema = z.object({
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64),
  promptVersion: z.string().min(1).max(64).optional(),
});
export type TimelineGenerator = z.infer<typeof TimelineGeneratorSchema>;

export const TimelineMetadataSchema = z.object({
  generator: TimelineGeneratorSchema,
  language: LanguageTagSchema.optional(),
  createdAt: IsoDateTimeSchema.optional(),
});
export type TimelineMetadata = z.infer<typeof TimelineMetadataSchema>;

/** Structural timeline schema WITHOUT the cross-field invariants (see `TimelineSchema`). */
export const TimelineBaseSchema = z.object({
  schemaVersion: z.literal(CURRENT_TIMELINE_VERSION),
  id: IdSchema,
  title: z.string().max(200),
  settings: RenderSettingsSchema,
  durationInFrames: DurationFramesSchema,
  brand: BrandKitSchema.optional(),
  assets: z.array(AssetRefSchema),
  chapters: z.array(ChapterSchema).min(1),
  scenes: z.array(SceneSchema).min(1),
  tracks: z.array(TrackSchema),
  metadata: TimelineMetadataSchema,
});
export type TimelineBase = z.infer<typeof TimelineBaseSchema>;

type Path = (string | number)[];
type IssueSink = (path: Path, message: string) => void;

/** Invariant 1 / 2 helper: contiguous spans covering [0, total]. */
function checkContiguous(
  spans: readonly { startFrame: number; durationInFrames: number }[],
  total: number,
  key: 'scenes' | 'chapters',
  report: IssueSink,
): void {
  const label = key === 'scenes' ? 'Scene' : 'Chapter';
  let expectedStart = 0;
  spans.forEach((span, i) => {
    if (span.startFrame !== expectedStart) {
      const message =
        i === 0
          ? `${label} 0 must start at frame 0 (got ${span.startFrame})`
          : `${label}s must be sorted and contiguous: expected startFrame ${expectedStart}, got ${span.startFrame}`;
      report([key, i, 'startFrame'], message);
    }
    expectedStart = span.startFrame + span.durationInFrames;
  });
  const last = spans[spans.length - 1];
  if (last && last.startFrame + last.durationInFrames !== total) {
    report(
      [key, spans.length - 1, 'durationInFrames'],
      `Last ${label.toLowerCase()} must end exactly at durationInFrames ${total} (ends at ${last.startFrame + last.durationInFrames})`,
    );
  }
}

function checkAssetRef(
  assets: ReadonlyMap<string, AssetRef>,
  assetId: string,
  expected: AssetKind,
  path: Path,
  report: IssueSink,
): void {
  const asset = assets.get(assetId);
  if (!asset) {
    report(path, `Unknown asset "${assetId}" (not listed in timeline.assets)`);
  } else if (asset.kind !== expected) {
    report(path, `Asset "${assetId}" must be of kind "${expected}" (got "${asset.kind}")`);
  }
}

function checkLayers(
  layers: readonly Layer2D[],
  containerDuration: number,
  basePath: Path,
  assets: ReadonlyMap<string, AssetRef>,
  claimId: (id: string, path: Path) => void,
  report: IssueSink,
): void {
  layers.forEach((layer, k) => {
    const path = [...basePath, k];
    claimId(layer.id, [...path, 'id']);
    if (layer.type === 'image') checkAssetRef(assets, layer.assetId, 'image', [...path, 'assetId'], report);
    if (layer.startFrame + layer.durationInFrames > containerDuration) {
      report(
        [...path, 'durationInFrames'],
        `Layer "${layer.id}" ends at ${layer.startFrame + layer.durationInFrames}, beyond its container duration ${containerDuration}`,
      );
    }
  });
}

/** Applies the timeline invariants 1–9 to a structurally valid timeline. */
function checkTimelineInvariants(t: TimelineBase, report: IssueSink): void {
  const total = t.durationInFrames;

  // 3. Global id namespace.
  const seenIds = new Map<string, string>();
  const claimId = (id: string, path: Path) => {
    const where = path.join('.');
    const first = seenIds.get(id);
    if (first !== undefined) report(path, `Duplicate id "${id}" (already used at ${first})`);
    else seenIds.set(id, where);
  };
  t.chapters.forEach((c, i) => claimId(c.id, ['chapters', i, 'id']));
  t.scenes.forEach((s, i) => claimId(s.id, ['scenes', i, 'id']));
  t.assets.forEach((a, i) => claimId(a.id, ['assets', i, 'id']));
  t.tracks.forEach((track, i) => {
    claimId(track.id, ['tracks', i, 'id']);
    track.items.forEach((item, j) => claimId(item.id, ['tracks', i, 'items', j, 'id']));
  });

  const assets = new Map<string, AssetRef>();
  for (const a of t.assets) if (!assets.has(a.id)) assets.set(a.id, a);

  // 1. Scene contiguity.
  checkContiguous(t.scenes, total, 'scenes', report);
  // 2. Chapter contiguity + scene membership.
  checkContiguous(t.chapters, total, 'chapters', report);
  const chapterIndex = new Map<string, number>();
  t.chapters.forEach((c, i) => {
    if (!chapterIndex.has(c.id)) chapterIndex.set(c.id, i);
  });
  let previousChapter = -1;
  t.scenes.forEach((scene, i) => {
    const ci = chapterIndex.get(scene.chapterId);
    const chapter = ci === undefined ? undefined : t.chapters[ci];
    if (ci === undefined || !chapter) {
      report(['scenes', i, 'chapterId'], `Unknown chapter "${scene.chapterId}"`);
      return;
    }
    if (ci < previousChapter) {
      report(['scenes', i, 'chapterId'], `Scene order goes back to an earlier chapter ("${scene.chapterId}")`);
    }
    previousChapter = Math.max(previousChapter, ci);
    const chapterEnd = chapter.startFrame + chapter.durationInFrames;
    if (scene.startFrame < chapter.startFrame) {
      report(['scenes', i, 'startFrame'], `Scene starts before its chapter "${chapter.id}" (${chapter.startFrame})`);
    }
    if (scene.startFrame + scene.durationInFrames > chapterEnd) {
      report(['scenes', i, 'durationInFrames'], `Scene ends after its chapter "${chapter.id}" (${chapterEnd})`);
    }
  });

  // Scenes: assets (4), transitions (6), camera (7), layers (8), generated (9).
  t.scenes.forEach((scene, i) => {
    const base: Path = ['scenes', i];
    const content = scene.content;
    const cp: Path = [...base, 'content'];
    switch (content.engine) {
      case 'motion2d':
        checkLayers(content.layers, scene.durationInFrames, [...cp, 'layers'], assets, claimId, report);
        break;
      case 'three':
        if (content.modelAssetId !== undefined) {
          checkAssetRef(assets, content.modelAssetId, 'model3d', [...cp, 'modelAssetId'], report);
        }
        break;
      case 'footage':
      case 'screen':
        checkAssetRef(assets, content.assetId, 'video', [...cp, 'assetId'], report);
        break;
      case 'image':
        checkAssetRef(assets, content.assetId, 'image', [...cp, 'assetId'], report);
        break;
      case 'generated':
        if (content.assetId !== undefined) {
          checkAssetRef(assets, content.assetId, 'video', [...cp, 'assetId'], report);
        } else if (content.status === 'ready') {
          report([...cp, 'assetId'], 'A generated scene with status "ready" requires an assetId');
        }
        break;
    }

    const transition = scene.transitionIn;
    if (transition) {
      const previous = i > 0 ? t.scenes[i - 1] : undefined;
      if (!previous) {
        if (transition.type !== 'cut') {
          report([...base, 'transitionIn'], 'The first scene cannot have a transitionIn (other than "cut")');
        }
      } else {
        const maxDuration = Math.min(scene.durationInFrames, previous.durationInFrames);
        if (transition.durationInFrames > maxDuration) {
          report(
            [...base, 'transitionIn', 'durationInFrames'],
            `Transition duration ${transition.durationInFrames} exceeds min(scene, previous scene) duration ${maxDuration}`,
          );
        }
      }
    }

    const camera = scene.camera;
    if (camera) {
      const expectedSpace = content.engine === 'three' ? '3d' : '2d';
      if (camera.space !== expectedSpace) {
        report(
          [...base, 'camera', 'space'],
          `Camera space "${camera.space}" is not allowed on a "${content.engine}" scene (expected "${expectedSpace}")`,
        );
      }
      let previousFrame = -1;
      camera.keyframes.forEach((kf, k) => {
        const path: Path = [...base, 'camera', 'keyframes', k, 'frame'];
        if (kf.frame >= scene.durationInFrames) {
          report(path, `Camera keyframe frame ${kf.frame} must be < scene duration ${scene.durationInFrames}`);
        } else if (kf.frame <= previousFrame) {
          report(path, `Camera keyframe frames must be strictly increasing (${kf.frame} after ${previousFrame})`);
        }
        previousFrame = Math.max(previousFrame, kf.frame);
      });
    }
  });

  if (t.brand?.logoAssetId !== undefined) {
    checkAssetRef(assets, t.brand.logoAssetId, 'image', ['brand', 'logoAssetId'], report);
  }

  // Tracks: bounds + overlap (5), assets (4), fades (8).
  t.tracks.forEach((track, ti) => {
    let previousEnd = 0;
    let previousStart = -1;
    track.items.forEach((item, j) => {
      const path: Path = ['tracks', ti, 'items', j];
      const end = item.startFrame + item.durationInFrames;
      if (item.startFrame >= total) {
        report([...path, 'startFrame'], `Track item starts at ${item.startFrame}, outside the timeline [0, ${total}]`);
      } else if (end > total) {
        report([...path, 'durationInFrames'], `Track item ends at ${end}, beyond the timeline duration ${total}`);
      }
      if (item.startFrame < previousStart) {
        report([...path, 'startFrame'], 'Track items must be sorted by startFrame');
      } else if (item.startFrame < previousEnd) {
        report([...path, 'startFrame'], `Track item overlaps the previous item (which ends at ${previousEnd})`);
      }
      previousStart = item.startFrame;
      previousEnd = Math.max(previousEnd, end);
    });

    switch (track.kind) {
      case 'audio':
        track.items.forEach((item, j) => {
          const path: Path = ['tracks', ti, 'items', j];
          checkAssetRef(assets, item.assetId, 'audio', [...path, 'assetId'], report);
          if (item.fadeInFrames + item.fadeOutFrames > item.durationInFrames) {
            report(
              [...path, 'fadeOutFrames'],
              `fadeInFrames + fadeOutFrames (${item.fadeInFrames + item.fadeOutFrames}) exceeds durationInFrames ${item.durationInFrames}`,
            );
          }
        });
        break;
      case 'video':
        track.items.forEach((item, j) => {
          checkAssetRef(assets, item.assetId, 'video', ['tracks', ti, 'items', j, 'assetId'], report);
        });
        break;
      case 'overlay':
        track.items.forEach((item, j) => {
          const cp: Path = ['tracks', ti, 'items', j, 'content'];
          if (item.content.engine === 'image') {
            checkAssetRef(assets, item.content.assetId, 'image', [...cp, 'assetId'], report);
          } else {
            checkLayers(item.content.layers, item.durationInFrames, [...cp, 'layers'], assets, claimId, report);
          }
        });
        break;
      case 'caption':
        break;
    }
  });
}

/**
 * Timeline v1 with cross-field invariants (each reported with a precise `path`):
 * 1. scenes sorted, contiguous, from 0 to `durationInFrames`;
 * 2. chapters contiguous over [0, durationInFrames], scenes reference existing chapters, lie inside them and never go back;
 * 3. globally unique ids (chapters, scenes, assets, tracks, track items, layers);
 * 4. asset references exist with a compatible kind;
 * 5. track items within [0, durationInFrames], sorted and non-overlapping per track;
 * 6. no transitionIn (other than `cut`) on the first scene; duration ≤ min(scene, previous scene);
 * 7. camera keyframes `< scene.durationInFrames`, strictly increasing; `3d` only on `three` scenes;
 * 8. audio fades fit the item; layers fit the scene;
 * 9. generated `ready` ⇒ `assetId`.
 */
export const TimelineSchema = TimelineBaseSchema.superRefine((timeline, ctx) => {
  checkTimelineInvariants(timeline, (path, message) => {
    ctx.addIssue({ code: 'custom', path, message });
  });
});
export type Timeline = z.infer<typeof TimelineSchema>;

/** Migrates (see `migrateTimeline`) then parses. Throws `TimelineMigrationError` or `ZodError`. */
export function parseTimeline(input: unknown): Timeline {
  return TimelineSchema.parse(migrateTimeline(input));
}

export type SafeParseTimelineResult = { success: true; data: Timeline } | { success: false; error: z.ZodError };

/** Non-throwing variant of `parseTimeline`; migration failures are reported as a ZodError at `schemaVersion`. */
export function safeParseTimeline(input: unknown): SafeParseTimelineResult {
  let migrated: Record<string, unknown>;
  try {
    migrated = migrateTimeline(input);
  } catch (err) {
    if (!(err instanceof TimelineMigrationError)) throw err;
    const error = new z.ZodError([
      {
        code: 'custom',
        path: err.code === 'INVALID_DOCUMENT' ? [] : ['schemaVersion'],
        message: err.message,
        input,
      },
    ]);
    return { success: false, error };
  }
  const result = TimelineSchema.safeParse(migrated);
  return result.success ? { success: true, data: result.data } : { success: false, error: result.error };
}
