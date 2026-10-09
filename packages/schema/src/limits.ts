import { z } from 'zod';
import type { VideoRequest } from './director';
import { resolveDimensions } from './render-settings';
import type { Timeline } from './timeline';

const PositiveIntSchema = z.number().int().positive();

const CORE_RESOURCE_LIMITS_SHAPE = {
  maxDurationSeconds: PositiveIntSchema,
  maxWidth: PositiveIntSchema,
  maxHeight: PositiveIntSchema,
  maxFps: PositiveIntSchema,
  maxScenes: PositiveIntSchema,
  maxChapters: PositiveIntSchema,
  maxTracks: PositiveIntSchema,
  maxAssets: PositiveIntSchema,
  maxPromptChars: PositiveIntSchema,
};

/** The nine core limits (all required). */
export const CoreResourceLimitsSchema = z.object(CORE_RESOURCE_LIMITS_SHAPE);

/**
 * Optional timeline-size limits. When a field is absent, `checkTimelineLimits` uses `DEFAULT_RESOURCE_LIMITS`.
 * - `maxTrackItems`: total number of items over ALL tracks;
 * - `maxLayers`: total number of 2D layers over all scenes and overlay items;
 * - `maxTimelineBytes`: UTF-8 size of `JSON.stringify(timeline)`.
 */
export const TimelineSizeLimitsSchema = z.object({
  maxTrackItems: PositiveIntSchema.optional(),
  maxLayers: PositiveIntSchema.optional(),
  maxTimelineBytes: PositiveIntSchema.optional(),
});
export type TimelineSizeLimits = z.infer<typeof TimelineSizeLimitsSchema>;

/**
 * Configurable resource limits. These are NOT hardcoded maxima: apps override them from env.
 * The nine core limits are required; the timeline-size limits (`maxTrackItems`, `maxLayers`, `maxTimelineBytes`) are
 * optional and default to `DEFAULT_RESOURCE_LIMITS`.
 */
export const ResourceLimitsSchema = z.object({
  ...CORE_RESOURCE_LIMITS_SHAPE,
  ...TimelineSizeLimitsSchema.shape,
});

/**
 * The core limits. Deliberately WITHOUT the optional size limits so `limits[key]` for `key: keyof ResourceLimits`
 * stays `number`; use `FullResourceLimits` (= `z.infer<typeof ResourceLimitsSchema>`) to also carry size limits.
 * Every function taking limits accepts `FullResourceLimits`, and a plain `ResourceLimits` value works too.
 */
export type ResourceLimits = z.infer<typeof CoreResourceLimitsSchema>;
export type FullResourceLimits = ResourceLimits & TimelineSizeLimits;

/** Defaults only — apps override these from env. */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits & Required<TimelineSizeLimits>> = Object.freeze({
  maxDurationSeconds: 7200,
  maxWidth: 3840,
  maxHeight: 3840,
  maxFps: 60,
  maxScenes: 2000,
  maxChapters: 200,
  maxTracks: 50,
  maxAssets: 500,
  maxPromptChars: 20000,
  maxTrackItems: 20_000,
  maxLayers: 5_000,
  maxTimelineBytes: 20 * 1024 * 1024,
});

export const LimitViolationCodeSchema = z.enum([
  'MAX_DURATION_SECONDS',
  'MAX_WIDTH',
  'MAX_HEIGHT',
  'MAX_FPS',
  'MAX_SCENES',
  'MAX_CHAPTERS',
  'MAX_TRACKS',
  'MAX_ASSETS',
  'MAX_PROMPT_CHARS',
  'MAX_TRACK_ITEMS',
  'MAX_LAYERS',
  'MAX_TIMELINE_BYTES',
  'INVALID_DIMENSIONS',
]);
export type LimitViolationCode = z.infer<typeof LimitViolationCodeSchema>;

export const LimitViolationSchema = z.object({
  code: LimitViolationCodeSchema,
  message: z.string(),
  limit: z.number(),
  actual: z.number(),
});
export type LimitViolation = z.infer<typeof LimitViolationSchema>;

function check(
  out: LimitViolation[],
  code: LimitViolationCode,
  label: string,
  actual: number,
  limit: number,
): void {
  if (actual > limit) {
    out.push({ code, message: `${label} ${actual} exceeds the configured limit of ${limit}`, limit, actual });
  }
}

/** UTF-8 byte length of a string (lone surrogates count as 3 bytes, like U+FFFD). No `TextEncoder` needed. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Total number of 2D layers in a timeline (scene layers + overlay item layers). */
export function countTimelineLayers(timeline: Timeline): number {
  let layers = 0;
  for (const scene of timeline.scenes) {
    if (scene.content.engine === 'motion2d') layers += scene.content.layers.length;
  }
  for (const track of timeline.tracks) {
    if (track.kind !== 'overlay') continue;
    for (const item of track.items) {
      if (item.content.engine === 'motion2d') layers += item.content.layers.length;
    }
  }
  return layers;
}

/** Total number of items over all tracks. */
export function countTimelineTrackItems(timeline: Timeline): number {
  let items = 0;
  for (const track of timeline.tracks) items += track.items.length;
  return items;
}

/**
 * Checks a (valid) timeline against resource limits. Empty array = within limits.
 * Optional size limits missing from `limits` fall back to `DEFAULT_RESOURCE_LIMITS`.
 */
export function checkTimelineLimits(timeline: Timeline, limits: FullResourceLimits): LimitViolation[] {
  const out: LimitViolation[] = [];
  const durationSeconds = timeline.durationInFrames / timeline.settings.fps;
  check(out, 'MAX_DURATION_SECONDS', 'Duration (seconds)', durationSeconds, limits.maxDurationSeconds);
  check(out, 'MAX_WIDTH', 'Width (px)', timeline.settings.width, limits.maxWidth);
  check(out, 'MAX_HEIGHT', 'Height (px)', timeline.settings.height, limits.maxHeight);
  check(out, 'MAX_FPS', 'Frame rate', timeline.settings.fps, limits.maxFps);
  check(out, 'MAX_SCENES', 'Scene count', timeline.scenes.length, limits.maxScenes);
  check(out, 'MAX_CHAPTERS', 'Chapter count', timeline.chapters.length, limits.maxChapters);
  check(out, 'MAX_TRACKS', 'Track count', timeline.tracks.length, limits.maxTracks);
  check(out, 'MAX_ASSETS', 'Asset count', timeline.assets.length, limits.maxAssets);
  for (const scene of timeline.scenes) {
    if (scene.content.engine === 'generated') {
      check(out, 'MAX_PROMPT_CHARS', `Scene "${scene.id}" prompt length`, scene.content.prompt.length, limits.maxPromptChars);
    }
  }
  check(
    out,
    'MAX_TRACK_ITEMS',
    'Track item count (all tracks)',
    countTimelineTrackItems(timeline),
    limits.maxTrackItems ?? DEFAULT_RESOURCE_LIMITS.maxTrackItems,
  );
  check(
    out,
    'MAX_LAYERS',
    'Layer count (scenes and overlays)',
    countTimelineLayers(timeline),
    limits.maxLayers ?? DEFAULT_RESOURCE_LIMITS.maxLayers,
  );
  check(
    out,
    'MAX_TIMELINE_BYTES',
    'Timeline JSON size (bytes)',
    utf8ByteLength(JSON.stringify(timeline)),
    limits.maxTimelineBytes ?? DEFAULT_RESOURCE_LIMITS.maxTimelineBytes,
  );
  return out;
}

/** Checks a (valid) video request against resource limits. Empty array = within limits. */
export function checkVideoRequestLimits(request: VideoRequest, limits: FullResourceLimits): LimitViolation[] {
  const out: LimitViolation[] = [];
  check(out, 'MAX_DURATION_SECONDS', 'Duration (seconds)', request.durationSeconds, limits.maxDurationSeconds);
  try {
    const { width, height } = resolveDimensions(request);
    check(out, 'MAX_WIDTH', 'Width (px)', width, limits.maxWidth);
    check(out, 'MAX_HEIGHT', 'Height (px)', height, limits.maxHeight);
  } catch (err) {
    out.push({
      code: 'INVALID_DIMENSIONS',
      message: err instanceof Error ? err.message : 'Unable to resolve output dimensions',
      limit: 0,
      actual: 0,
    });
  }
  check(out, 'MAX_FPS', 'Frame rate', request.fps, limits.maxFps);
  check(out, 'MAX_PROMPT_CHARS', 'Prompt length', request.prompt.length, limits.maxPromptChars);
  check(out, 'MAX_ASSETS', 'Reference asset count', request.referenceAssetIds.length, limits.maxAssets);
  return out;
}
