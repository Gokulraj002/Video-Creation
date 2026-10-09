import { z } from 'zod';
import { EasingSchema, FrameSchema, type Easing } from './common';

export const CameraPresetSchema = z.enum([
  'static',
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'orbit-left',
  'orbit-right',
  'dolly-in',
  'dolly-out',
  'crane-up',
  'crane-down',
  'ken-burns',
  'handheld',
]);
export type CameraPreset = z.infer<typeof CameraPresetSchema>;

export const CameraSpaceSchema = z.enum(['2d', '3d']);
export type CameraSpace = z.infer<typeof CameraSpaceSchema>;

/** Finite camera coordinate, |v| <= 10 000. */
export const CameraCoordinateSchema = z.number().min(-10_000).max(10_000);

export const Vec3Schema = z.tuple([CameraCoordinateSchema, CameraCoordinateSchema, CameraCoordinateSchema]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/** 2D camera keyframe; `frame` is RELATIVE to the scene start. x/y are normalized offsets of the view center. */
export const Camera2DKeyframeSchema = z.object({
  frame: FrameSchema,
  x: CameraCoordinateSchema,
  y: CameraCoordinateSchema,
  zoom: z.number().gt(0).max(20),
  rotation: CameraCoordinateSchema,
  easing: EasingSchema,
});
export type Camera2DKeyframe = z.infer<typeof Camera2DKeyframeSchema>;

/** 3D camera keyframe; `frame` is RELATIVE to the scene start. */
export const Camera3DKeyframeSchema = z.object({
  frame: FrameSchema,
  position: Vec3Schema,
  target: Vec3Schema,
  fov: z.number().min(1).max(179),
  easing: EasingSchema,
});
export type Camera3DKeyframe = z.infer<typeof Camera3DKeyframeSchema>;

export const Camera2DTrackSchema = z.object({
  space: z.literal('2d'),
  preset: CameraPresetSchema.optional(),
  keyframes: z.array(Camera2DKeyframeSchema).min(1).max(500),
});
export type Camera2DTrack = z.infer<typeof Camera2DTrackSchema>;

export const Camera3DTrackSchema = z.object({
  space: z.literal('3d'),
  preset: CameraPresetSchema.optional(),
  keyframes: z.array(Camera3DKeyframeSchema).min(1).max(500),
});
export type Camera3DTrack = z.infer<typeof Camera3DTrackSchema>;

export const CameraTrackSchema = z.discriminatedUnion('space', [Camera2DTrackSchema, Camera3DTrackSchema]);
export type CameraTrack = z.infer<typeof CameraTrackSchema>;

// ---------------------------------------------------------------------------------------------
// Preset expansion (deterministic; used by the director compiler)
// ---------------------------------------------------------------------------------------------

const MOVE_EASING: Easing = 'ease-in-out';

/** `count` strictly increasing frames from 0 to durationInFrames - 1 (count clamped to the duration). */
function spreadFrames(count: number, durationInFrames: number): number[] {
  const last = Math.max(0, durationInFrames - 1);
  const k = Math.max(1, Math.min(count, last + 1));
  if (k === 1) return [0];
  return Array.from({ length: k }, (_, i) => Math.round((i * last) / (k - 1)));
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

interface Pose2D {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
}

function linear2D(from: Pose2D, to: Pose2D, durationInFrames: number): Camera2DKeyframe[] {
  const frames = spreadFrames(2, durationInFrames);
  if (frames.length === 1) return [{ frame: 0, ...from, easing: 'linear' }];
  return [
    { frame: frames[0] ?? 0, ...from, easing: MOVE_EASING },
    { frame: frames[1] ?? 0, ...to, easing: MOVE_EASING },
  ];
}

const BASE_2D: Pose2D = { x: 0, y: 0, zoom: 1, rotation: 0 };

function expand2D(preset: CameraPreset, d: number): Camera2DKeyframe[] {
  switch (preset) {
    case 'static':
      return [{ frame: 0, ...BASE_2D, easing: 'linear' }];
    case 'push-in':
    case 'dolly-in':
      return linear2D(BASE_2D, { ...BASE_2D, zoom: 1.15 }, d);
    case 'pull-out':
    case 'dolly-out':
      return linear2D({ ...BASE_2D, zoom: 1.15 }, BASE_2D, d);
    case 'pan-left':
      return linear2D(BASE_2D, { ...BASE_2D, x: -0.1 }, d);
    case 'pan-right':
      return linear2D(BASE_2D, { ...BASE_2D, x: 0.1 }, d);
    case 'tilt-up':
    case 'crane-up':
      return linear2D(BASE_2D, { ...BASE_2D, y: -0.1 }, d);
    case 'tilt-down':
    case 'crane-down':
      return linear2D(BASE_2D, { ...BASE_2D, y: 0.1 }, d);
    case 'orbit-left':
      return linear2D(BASE_2D, { x: -0.1, y: 0, zoom: 1.05, rotation: -2 }, d);
    case 'orbit-right':
      return linear2D(BASE_2D, { x: 0.1, y: 0, zoom: 1.05, rotation: 2 }, d);
    case 'ken-burns':
      return linear2D(BASE_2D, { x: 0.04, y: -0.03, zoom: 1.12, rotation: 0 }, d);
    case 'handheld': {
      const frames = spreadFrames(6, d);
      return frames.map((frame, i) => ({
        frame,
        x: round4(i === 0 ? 0 : 0.008 * Math.sin(i * 1.7)),
        y: round4(i === 0 ? 0 : 0.006 * Math.cos(i * 2.3)),
        zoom: 1.03,
        rotation: round4(i === 0 ? 0 : 0.4 * Math.sin(i * 1.1)),
        easing: 'ease-in-out' as const,
      }));
    }
  }
}

interface Pose3D {
  position: Vec3;
  target: Vec3;
  fov: number;
}

const BASE_3D: Pose3D = { position: [0, 1, 8], target: [0, 0, 0], fov: 50 };

function linear3D(from: Pose3D, to: Pose3D, d: number): Camera3DKeyframe[] {
  const frames = spreadFrames(2, d);
  if (frames.length === 1) return [{ frame: 0, ...from, easing: 'linear' }];
  return [
    { frame: frames[0] ?? 0, ...from, easing: MOVE_EASING },
    { frame: frames[1] ?? 0, ...to, easing: MOVE_EASING },
  ];
}

function orbit3D(direction: 1 | -1, d: number): Camera3DKeyframe[] {
  const radius = 6;
  const frames = spreadFrames(5, d);
  const sweep = Math.PI / 2; // quarter orbit over the scene
  return frames.map((frame, i) => {
    const t = frames.length === 1 ? 0 : i / (frames.length - 1);
    const angle = direction * sweep * t;
    return {
      frame,
      position: [round4(radius * Math.sin(angle)), 1.5, round4(radius * Math.cos(angle))] as Vec3,
      target: [0, 0, 0] as Vec3,
      fov: 50,
      easing: 'linear' as const,
    };
  });
}

function expand3D(preset: CameraPreset, d: number): Camera3DKeyframe[] {
  switch (preset) {
    case 'static':
      return [{ frame: 0, ...BASE_3D, easing: 'linear' }];
    case 'orbit-left':
      return orbit3D(-1, d);
    case 'orbit-right':
      return orbit3D(1, d);
    case 'dolly-in':
      return linear3D({ ...BASE_3D, position: [0, 1, 8] }, { ...BASE_3D, position: [0, 1, 5] }, d);
    case 'dolly-out':
      return linear3D({ ...BASE_3D, position: [0, 1, 5] }, { ...BASE_3D, position: [0, 1, 8] }, d);
    case 'push-in':
      return linear3D(BASE_3D, { ...BASE_3D, fov: 40 }, d);
    case 'pull-out':
      return linear3D({ ...BASE_3D, fov: 40 }, BASE_3D, d);
    case 'crane-up':
      return linear3D({ ...BASE_3D, position: [0, 0.5, 8] }, { ...BASE_3D, position: [0, 4, 8] }, d);
    case 'crane-down':
      return linear3D({ ...BASE_3D, position: [0, 4, 8] }, { ...BASE_3D, position: [0, 0.5, 8] }, d);
    case 'pan-left':
      return linear3D(BASE_3D, { ...BASE_3D, target: [-2, 0, 0] }, d);
    case 'pan-right':
      return linear3D(BASE_3D, { ...BASE_3D, target: [2, 0, 0] }, d);
    case 'tilt-up':
      return linear3D(BASE_3D, { ...BASE_3D, target: [0, 1.5, 0] }, d);
    case 'tilt-down':
      return linear3D(BASE_3D, { ...BASE_3D, target: [0, -1.5, 0] }, d);
    case 'ken-burns':
      return linear3D(BASE_3D, { ...BASE_3D, position: [0.6, 1.2, 7] }, d);
    case 'handheld': {
      const frames = spreadFrames(6, d);
      return frames.map((frame, i) => ({
        frame,
        position: [
          round4(i === 0 ? 0 : 0.05 * Math.sin(i * 1.7)),
          round4(1 + (i === 0 ? 0 : 0.04 * Math.cos(i * 2.3))),
          8,
        ] as Vec3,
        target: [0, 0, 0] as Vec3,
        fov: 50,
        easing: 'ease-in-out' as const,
      }));
    }
  }
}

/**
 * Expands a camera preset into deterministic keyframes for a scene of `durationInFrames` frames.
 * Keyframe frames are relative to the scene start, strictly increasing and `< durationInFrames`.
 */
export function expandCameraPreset(preset: CameraPreset, space: CameraSpace, durationInFrames: number): CameraTrack {
  if (!Number.isInteger(durationInFrames) || durationInFrames < 1) {
    throw new RangeError('durationInFrames must be an integer >= 1');
  }
  if (space === '2d') {
    return { space: '2d', preset, keyframes: expand2D(preset, durationInFrames) };
  }
  return { space: '3d', preset, keyframes: expand3D(preset, durationInFrames) };
}
