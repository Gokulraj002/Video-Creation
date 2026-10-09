import {
  TimelineSchema,
  VideoRequestSchema,
  type ReferenceProfile,
  type Timeline,
  type VideoRequest,
  type VideoRequestInput,
} from '@vc/schema';
import { expect } from 'vitest';
import {
  HeuristicMockProvider,
  ScriptedMockProvider,
  type DirectorResult,
  type ScriptedHandler,
  type StructuredGenerationRequest,
} from '../src';

export function makeRequest(overrides: Partial<VideoRequestInput> = {}): VideoRequest {
  return VideoRequestSchema.parse({
    title: 'Aurora Smart Bottle',
    prompt:
      'Launch video for the Aurora smart water bottle. It tracks hydration and glows to remind you to drink. ' +
      'Battery lasts 30 days on a single charge. Order yours at aurora.example.com today.',
    genre: 'promo',
    durationSeconds: 30,
    aspectRatio: '16:9',
    resolution: '1080p',
    voiceOver: { enabled: true, style: 'warm', gender: 'female' },
    music: { enabled: true, mood: 'uplifting' },
    brand: { name: 'Aurora', colors: ['#0EA5E9', '#F97316'] },
    ...overrides,
  });
}

export function makeReference(overrides: Partial<ReferenceProfile> = {}): ReferenceProfile {
  return {
    schemaVersion: 1,
    id: 'ref-1',
    assetId: 'asset-ref-1',
    kind: 'video',
    createdAt: '2026-10-01T10:00:00.000Z',
    metadata: { durationSeconds: 60, width: 1920, height: 1080, fps: 30, hasAudio: true },
    scenes: [
      { index: 0, startSeconds: 0, endSeconds: 4, keyframeAssetIds: [], shotType: 'wide', cameraMovement: 'dolly-in', dominantColors: ['#111111'] },
      { index: 1, startSeconds: 4, endSeconds: 8, keyframeAssetIds: [], shotType: 'close-up', cameraMovement: 'static', dominantColors: ['#EEEEEE'] },
    ],
    palette: [
      { hex: '#112233', weight: 0.6 },
      { hex: '#FFCC00', weight: 0.4 },
    ],
    transitions: [
      { type: 'crossfade', count: 7 },
      { type: 'cut', count: 3 },
    ],
    pacing: { averageShotSeconds: 4, cutsPerMinute: 15 },
    styleSummary: 'Moody, high-contrast product film with slow dolly moves.',
    moodTags: ['moody', 'premium'],
    warnings: [],
    ...overrides,
  };
}

/** Scripted provider that delegates to the heuristic mock unless `override` returns a value (non-undefined). */
export function delegatingProvider(
  override?: (req: StructuredGenerationRequest<unknown>, callIndex: number) => unknown | Promise<unknown>,
): ScriptedMockProvider {
  const heuristic = new HeuristicMockProvider();
  const handler: ScriptedHandler = async (req, callIndex) => {
    const custom = override ? await override(req, callIndex) : undefined;
    if (custom !== undefined) return custom;
    return (await heuristic.generateStructured(req)).output;
  };
  return new ScriptedMockProvider(handler);
}

export function sumFrames(timeline: Timeline): number {
  return timeline.scenes.reduce((a, s) => a + s.durationInFrames, 0);
}

/** Structural assertions every director result must satisfy. */
export function expectValidResult(result: DirectorResult, request: VideoRequest): void {
  const parsed = TimelineSchema.safeParse(result.timeline);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5)));
  const expectedFrames = Math.max(1, Math.round(request.durationSeconds * request.fps));
  expect(result.timeline.durationInFrames).toBe(expectedFrames);
  expect(sumFrames(result.timeline)).toBe(expectedFrames);
  const chapterFrames = result.timeline.chapters.reduce((a, c) => a + c.durationInFrames, 0);
  expect(chapterFrames).toBe(expectedFrames);
  expect(result.timeline.chapters).toHaveLength(result.plan.chapterCount);
  const n = result.timeline.scenes.length;
  expect(n).toBeGreaterThanOrEqual(result.plan.sceneCountRange.min);
  expect(n).toBeLessThanOrEqual(result.plan.sceneCountRange.max);
  result.timeline.chapters.forEach((chapter, i) => {
    const count = result.timeline.scenes.filter((s) => s.chapterId === chapter.id).length;
    const range = result.plan.perChapterSceneRange[i];
    expect(range).toBeDefined();
    expect(count).toBeGreaterThanOrEqual(range?.min ?? 1);
    expect(count).toBeLessThanOrEqual(range?.max ?? 1);
  });
  expect(result.artifacts.storyboard.scenes).toHaveLength(n);
  expect(result.artifacts.sceneSpecs.scenes).toHaveLength(n);
  expect(result.artifacts.shotList.scenes).toHaveLength(n);
  expect(result.artifacts.engineSelection.choices).toHaveLength(n);
}

/** Timeline without the per-run fields (id, createdAt). */
export function stableTimeline(timeline: Timeline): Omit<Timeline, 'id' | 'metadata'> & { metadata: Omit<Timeline['metadata'], 'createdAt'> } {
  const { id: _id, metadata, ...rest } = timeline;
  void _id;
  const { createdAt: _createdAt, ...meta } = metadata;
  void _createdAt;
  return { ...rest, metadata: meta };
}
