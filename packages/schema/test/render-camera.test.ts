import { describe, expect, it } from 'vitest';
import {
  CameraPresetSchema,
  CameraTrackSchema,
  Camera2DKeyframeSchema,
  Camera3DKeyframeSchema,
  RenderSettingsSchema,
  expandCameraPreset,
  resolveDimensions,
  type Camera2DKeyframe,
  type Camera3DKeyframe,
  type CameraTrack,
} from '../src/index';

describe('resolveDimensions', () => {
  it.each([
    ['9:16', '1080p', 1080, 1920],
    ['16:9', '1080p', 1920, 1080],
    ['1:1', '720p', 720, 720],
    ['4:5', '1080p', 1080, 1350],
    ['16:9', '2160p', 3840, 2160],
    ['9:16', '720p', 720, 1280],
    ['16:9', '1440p', 2560, 1440],
    ['16:9', '480p', 854, 480],
    ['9:16', '480p', 480, 854],
    ['4:5', '480p', 480, 600],
  ] as const)('%s + %s → %i×%i', (aspectRatio, resolution, width, height) => {
    expect(resolveDimensions({ aspectRatio, resolution })).toEqual({ width, height });
  });

  it('always returns even integers for every preset combination', () => {
    for (const aspectRatio of ['9:16', '16:9', '1:1', '4:5'] as const) {
      for (const resolution of ['480p', '720p', '1080p', '1440p', '2160p'] as const) {
        const { width, height } = resolveDimensions({ aspectRatio, resolution });
        expect(width % 2).toBe(0);
        expect(height % 2).toBe(0);
        expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
      }
    }
  });

  it('uses custom dims when aspect ratio or resolution is custom', () => {
    expect(resolveDimensions({ aspectRatio: 'custom', resolution: '1080p', customWidth: 1000, customHeight: 500 })).toEqual({
      width: 1000,
      height: 500,
    });
    expect(resolveDimensions({ aspectRatio: '16:9', resolution: 'custom', customWidth: 641, customHeight: 361 })).toEqual({
      width: 642,
      height: 362,
    });
  });

  it('throws when custom dims are missing', () => {
    expect(() => resolveDimensions({ aspectRatio: 'custom', resolution: '1080p' })).toThrow(RangeError);
    expect(() => resolveDimensions({ aspectRatio: '1:1', resolution: 'custom', customWidth: 100 })).toThrow(RangeError);
    expect(() =>
      resolveDimensions({ aspectRatio: 'custom', resolution: 'custom', customWidth: 0, customHeight: 100 }),
    ).toThrow(RangeError);
  });
});

describe('RenderSettingsSchema', () => {
  const valid = {
    width: 1920,
    height: 1080,
    fps: 30,
    backgroundColor: '#000000',
    sampleRate: 48000,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
  it('accepts valid settings', () => {
    expect(RenderSettingsSchema.safeParse(valid).success).toBe(true);
    expect(RenderSettingsSchema.safeParse({ ...valid, width: 16, height: 8192, fps: 240, sampleRate: 44100 }).success).toBe(
      true,
    );
  });
  it.each([
    ['odd width', { width: 1921 }],
    ['width < 16', { width: 14 }],
    ['height > 8192', { height: 8194 }],
    ['fps 0', { fps: 0 }],
    ['fps 241', { fps: 241 }],
    ['fractional fps', { fps: 29.97 }],
    ['sample rate', { sampleRate: 22050 }],
    ['codec', { videoCodec: 'av1' }],
    ['audio codec', { audioCodec: 'mp3' }],
    ['color', { backgroundColor: 'black' }],
  ])('rejects %s', (_name, patch) => {
    expect(RenderSettingsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

function assertTrackValid(track: CameraTrack, durationInFrames: number): void {
  expect(CameraTrackSchema.safeParse(track).success).toBe(true);
  let previous = -1;
  for (const kf of track.keyframes) {
    expect(kf.frame).toBeGreaterThan(previous);
    expect(kf.frame).toBeLessThan(durationInFrames);
    previous = kf.frame;
  }
}

function kf2d(track: CameraTrack): Camera2DKeyframe[] {
  if (track.space !== '2d') throw new Error('expected 2d');
  return track.keyframes;
}

function kf3d(track: CameraTrack): Camera3DKeyframe[] {
  if (track.space !== '3d') throw new Error('expected 3d');
  return track.keyframes;
}

describe('expandCameraPreset', () => {
  it('produces valid, strictly increasing keyframes for every preset/space/duration', () => {
    for (const preset of CameraPresetSchema.options) {
      for (const space of ['2d', '3d'] as const) {
        for (const d of [1, 2, 3, 5, 30, 90, 1801, 216_000]) {
          const track = expandCameraPreset(preset, space, d);
          expect(track.space).toBe(space);
          expect(track.preset).toBe(preset);
          assertTrackValid(track, d);
        }
      }
    }
  });

  it('is deterministic', () => {
    for (const preset of CameraPresetSchema.options) {
      expect(expandCameraPreset(preset, '2d', 75)).toEqual(expandCameraPreset(preset, '2d', 75));
      expect(expandCameraPreset(preset, '3d', 75)).toEqual(expandCameraPreset(preset, '3d', 75));
    }
  });

  it('static is a single keyframe', () => {
    expect(kf2d(expandCameraPreset('static', '2d', 90))).toHaveLength(1);
    expect(kf3d(expandCameraPreset('static', '3d', 90))).toHaveLength(1);
  });

  it('2D push-in zooms 1 → 1.15 from the first to the last frame', () => {
    const kfs = kf2d(expandCameraPreset('push-in', '2d', 90));
    expect(kfs[0]).toMatchObject({ frame: 0, zoom: 1 });
    expect(kfs[kfs.length - 1]).toMatchObject({ frame: 89, zoom: 1.15 });
  });

  it('2D pans by ±0.1', () => {
    const left = kf2d(expandCameraPreset('pan-left', '2d', 60));
    const right = kf2d(expandCameraPreset('pan-right', '2d', 60));
    expect(left[left.length - 1]?.x).toBeCloseTo(-0.1);
    expect(right[right.length - 1]?.x).toBeCloseTo(0.1);
  });

  it('2D ken-burns zooms 1 → 1.12 with drift', () => {
    const kfs = kf2d(expandCameraPreset('ken-burns', '2d', 120));
    const last = kfs[kfs.length - 1];
    expect(kfs[0]?.zoom).toBe(1);
    expect(last?.zoom).toBeCloseTo(1.12);
    expect(Math.abs(last?.x ?? 0) + Math.abs(last?.y ?? 0)).toBeGreaterThan(0);
  });

  it('3D orbit keyframes lie on a circle of radius 6 around the origin', () => {
    for (const preset of ['orbit-left', 'orbit-right'] as const) {
      const kfs = kf3d(expandCameraPreset(preset, '3d', 120));
      expect(kfs.length).toBeGreaterThan(1);
      for (const kf of kfs) {
        const [x, , z] = kf.position;
        expect(Math.hypot(x, z)).toBeCloseTo(6, 3);
        expect(kf.target).toEqual([0, 0, 0]);
      }
    }
    const left = kf3d(expandCameraPreset('orbit-left', '3d', 120));
    const right = kf3d(expandCameraPreset('orbit-right', '3d', 120));
    expect(Math.sign(left[left.length - 1]?.position[0] ?? 0)).toBe(-1);
    expect(Math.sign(right[right.length - 1]?.position[0] ?? 0)).toBe(1);
  });

  it('3D dolly moves z 8 → 5 and crane moves y 0.5 → 4', () => {
    const dolly = kf3d(expandCameraPreset('dolly-in', '3d', 60));
    expect(dolly[0]?.position[2]).toBe(8);
    expect(dolly[dolly.length - 1]?.position[2]).toBe(5);
    const crane = kf3d(expandCameraPreset('crane-up', '3d', 60));
    expect(crane[0]?.position[1]).toBe(0.5);
    expect(crane[crane.length - 1]?.position[1]).toBe(4);
    const craneDown = kf3d(expandCameraPreset('crane-down', '3d', 60));
    expect(craneDown[0]?.position[1]).toBe(4);
    expect(craneDown[craneDown.length - 1]?.position[1]).toBe(0.5);
  });

  it('rejects invalid durations', () => {
    expect(() => expandCameraPreset('static', '2d', 0)).toThrow(RangeError);
    expect(() => expandCameraPreset('static', '3d', 1.5)).toThrow(RangeError);
  });
});

describe('camera keyframe schemas', () => {
  it('validates 2D zoom and coordinate bounds', () => {
    const kf = { frame: 0, x: 0, y: 0, zoom: 1, rotation: 0, easing: 'linear' };
    expect(Camera2DKeyframeSchema.safeParse(kf).success).toBe(true);
    expect(Camera2DKeyframeSchema.safeParse({ ...kf, zoom: 0 }).success).toBe(false);
    expect(Camera2DKeyframeSchema.safeParse({ ...kf, zoom: 20.01 }).success).toBe(false);
    expect(Camera2DKeyframeSchema.safeParse({ ...kf, x: 10_001 }).success).toBe(false);
    expect(Camera2DKeyframeSchema.safeParse({ ...kf, rotation: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(Camera2DKeyframeSchema.safeParse({ ...kf, frame: -1 }).success).toBe(false);
  });
  it('validates 3D fov and vectors', () => {
    const kf = { frame: 0, position: [0, 1, 8], target: [0, 0, 0], fov: 50, easing: 'spring' };
    expect(Camera3DKeyframeSchema.safeParse(kf).success).toBe(true);
    expect(Camera3DKeyframeSchema.safeParse({ ...kf, fov: 0.5 }).success).toBe(false);
    expect(Camera3DKeyframeSchema.safeParse({ ...kf, fov: 180 }).success).toBe(false);
    expect(Camera3DKeyframeSchema.safeParse({ ...kf, position: [0, 1] }).success).toBe(false);
    expect(Camera3DKeyframeSchema.safeParse({ ...kf, target: [0, 0, -10_001] }).success).toBe(false);
  });
  it('requires 1..500 keyframes', () => {
    expect(CameraTrackSchema.safeParse({ space: '2d', keyframes: [] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => ({ frame: i, x: 0, y: 0, zoom: 1, rotation: 0, easing: 'linear' }));
    expect(CameraTrackSchema.safeParse({ space: '2d', keyframes: many }).success).toBe(false);
    expect(CameraTrackSchema.safeParse({ space: '2d', keyframes: many.slice(0, 500) }).success).toBe(true);
  });
});
