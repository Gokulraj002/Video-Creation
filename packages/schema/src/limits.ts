import { z } from 'zod';
import type { VideoRequest } from './director';
import { resolveDimensions } from './render-settings';
import type { Timeline } from './timeline';

const PositiveIntSchema = z.number().int().positive();

/** Configurable resource limits. These are NOT hardcoded maxima: apps override them from env. */
export const ResourceLimitsSchema = z.object({
  maxDurationSeconds: PositiveIntSchema,
  maxWidth: PositiveIntSchema,
  maxHeight: PositiveIntSchema,
  maxFps: PositiveIntSchema,
  maxScenes: PositiveIntSchema,
  maxChapters: PositiveIntSchema,
  maxTracks: PositiveIntSchema,
  maxAssets: PositiveIntSchema,
  maxPromptChars: PositiveIntSchema,
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

/** Defaults only — apps override these from env. */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxDurationSeconds: 7200,
  maxWidth: 3840,
  maxHeight: 3840,
  maxFps: 60,
  maxScenes: 2000,
  maxChapters: 200,
  maxTracks: 50,
  maxAssets: 500,
  maxPromptChars: 20000,
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

/** Checks a (valid) timeline against resource limits. Empty array = within limits. */
export function checkTimelineLimits(timeline: Timeline, limits: ResourceLimits): LimitViolation[] {
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
  return out;
}

/** Checks a (valid) video request against resource limits. Empty array = within limits. */
export function checkVideoRequestLimits(request: VideoRequest, limits: ResourceLimits): LimitViolation[] {
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
