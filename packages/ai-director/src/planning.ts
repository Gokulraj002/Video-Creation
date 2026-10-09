import {
  allocateFrames,
  DEFAULT_RESOURCE_LIMITS,
  secondsToFrames,
  type ReferenceProfile,
  type ResourceLimits,
  type VideoGenre,
  type VideoRequest,
} from '@vc/schema';
import { LimitExceededError } from './errors';

export interface SceneCountRange {
  min: number;
  max: number;
}

export interface StructurePlan {
  fps: number;
  totalFrames: number;
  durationSeconds: number;
  chapterCount: number;
  /** Per-chapter target durations (seconds); sums to `durationSeconds` (±1e-6). */
  chapterTargetSeconds: number[];
  targetSceneSeconds: number;
  sceneCountRange: SceneCountRange;
  perChapterSceneRange: SceneCountRange[];
  /** True when the per-chapter stages run in more than one chunk. */
  chunked: boolean;
}

/** Target seconds per scene by genre (pacing). */
export const GENRE_TARGET_SCENE_SECONDS: Readonly<Record<VideoGenre, number>> = Object.freeze({
  'social-short': 2.5,
  'cinematic-ad': 3,
  promo: 3.5,
  comedy: 4,
  cartoon: 4,
  'motion-graphics': 4,
  'product-3d': 5,
  'real-estate': 5,
  'reference-based': 5,
  explainer: 7,
  'sop-training': 9,
  presentation: 10,
  'corporate-training': 10,
  'long-form': 12,
});

/** Scenes per chapter the chunker aims for (keeps every per-chapter LLM output small). */
export const SCENES_PER_CHAPTER = 24;
/** Seconds per chapter for long videos. */
export const SECONDS_PER_CHAPTER = 300;
/** Videos up to this length are planned as a single chapter. */
export const SINGLE_CHAPTER_MAX_SECONDS = 120;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Genre target, or the reference pacing (clamped 1.5..20 s) for reference-based videos. */
export function targetSceneSecondsFor(genre: VideoGenre, references: readonly ReferenceProfile[] = []): number {
  if (genre === 'reference-based') {
    const paced = references
      .map((r) => r.pacing?.averageShotSeconds)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
    if (paced.length > 0) {
      const avg = paced.reduce((a, b) => a + b, 0) / paced.length;
      return clamp(avg, 1.5, 20);
    }
  }
  return GENRE_TARGET_SCENE_SECONDS[genre];
}

/**
 * Deterministic structure plan for a request: scene-count range, chapter chunking and per-chapter targets.
 * Durations are unbounded except for `limits.maxDurationSeconds` (exceeding it throws `LIMIT_EXCEEDED`).
 */
export function planStructure(
  request: VideoRequest,
  references: readonly ReferenceProfile[] = [],
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): StructurePlan {
  const duration = request.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('durationSeconds must be a finite number > 0');
  }
  if (duration > limits.maxDurationSeconds) {
    throw new LimitExceededError(
      `Duration ${duration}s exceeds the configured limit of ${limits.maxDurationSeconds}s`,
      [
        {
          code: 'MAX_DURATION_SECONDS',
          message: `Duration (seconds) ${duration} exceeds the configured limit of ${limits.maxDurationSeconds}`,
          limit: limits.maxDurationSeconds,
          actual: duration,
        },
      ],
    );
  }
  const fps = request.fps;
  const totalFrames = Math.max(1, secondsToFrames(duration, fps));
  const targetSceneSeconds = targetSceneSecondsFor(request.genre, references);

  // Scene count: >= 1 s per scene, at most one frame per scene, never above maxScenes, and never more than
  // SCENES_PER_CHAPTER per allowed chapter (a small maxChapters must not pack thousands of scenes into one LLM call;
  // like maxScenes, it lengthens scenes instead).
  const hardMax = duration < 1 ? 1 : Math.max(1, Math.min(Math.floor(duration), totalFrames, limits.maxScenes));
  const chapterSceneCap = Math.max(1, limits.maxChapters) * SCENES_PER_CHAPTER;
  const expected = clamp(Math.round(duration / targetSceneSeconds), 1, Math.min(limits.maxScenes, hardMax, chapterSceneCap));
  const max = clamp(Math.ceil(expected * 1.25), 1, hardMax);
  const min = clamp(Math.floor(expected * 0.75), 1, max);
  const sceneCountRange = { min, max };

  let chapterCount =
    duration <= SINGLE_CHAPTER_MAX_SECONDS
      ? 1
      : Math.min(
          limits.maxChapters,
          Math.max(Math.ceil(duration / SECONDS_PER_CHAPTER), Math.ceil(expected / SCENES_PER_CHAPTER)),
        );
  // Every chapter needs at least one scene.
  chapterCount = clamp(chapterCount, 1, max);

  const chapterTargetSeconds: number[] = [];
  let assigned = 0;
  for (let i = 0; i < chapterCount; i++) {
    const t = i === chapterCount - 1 ? duration - assigned : duration / chapterCount;
    chapterTargetSeconds.push(t);
    assigned += t;
  }

  const weights = chapterTargetSeconds.map((t) => Math.max(t, 1e-9));
  const maxes = allocateFrames(weights, max, 1);
  const mins = min >= chapterCount ? allocateFrames(weights, min, 1) : new Array<number>(chapterCount).fill(1);
  const perChapterSceneRange = maxes.map((mx, i) => {
    const mn = Math.min(mins[i] ?? 1, mx);
    return { min: mn, max: mx };
  });

  return {
    fps,
    totalFrames,
    durationSeconds: duration,
    chapterCount,
    chapterTargetSeconds,
    targetSceneSeconds,
    sceneCountRange,
    perChapterSceneRange,
    chunked: chapterCount > 1,
  };
}

/** Total LLM + compile steps of a full run: brief + outline + 5 per chapter + compile. */
export function totalStepsFor(plan: Pick<StructurePlan, 'chapterCount'>): number {
  return 2 + 5 * plan.chapterCount + 1;
}
