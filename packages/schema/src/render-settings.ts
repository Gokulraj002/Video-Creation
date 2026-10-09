import { z } from 'zod';
import { HexColorSchema } from './common';

export const AspectRatioSchema = z.enum(['9:16', '16:9', '1:1', '4:5', 'custom']);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const ResolutionSchema = z.enum(['480p', '720p', '1080p', '1440p', '2160p', 'custom']);
export type Resolution = z.infer<typeof ResolutionSchema>;

export const MIN_DIMENSION = 16;
export const MAX_DIMENSION = 8192;

/** Even integer pixel dimension in [16, 8192]. */
export const EvenDimensionSchema = z
  .number()
  .int()
  .min(MIN_DIMENSION)
  .max(MAX_DIMENSION)
  .refine((n) => n % 2 === 0, { message: 'Dimension must be an even integer' });
export type EvenDimension = z.infer<typeof EvenDimensionSchema>;

/** Short-side pixel size for each preset resolution. */
export const RESOLUTION_SHORT_SIDE: Readonly<Record<Exclude<Resolution, 'custom'>, number>> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
};

/** Width / height ratio of each preset aspect ratio. */
export const ASPECT_RATIO_VALUES: Readonly<Record<Exclude<AspectRatio, 'custom'>, { w: number; h: number }>> = {
  '9:16': { w: 9, h: 16 },
  '16:9': { w: 16, h: 9 },
  '1:1': { w: 1, h: 1 },
  '4:5': { w: 4, h: 5 },
};

export interface ResolveDimensionsInput {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  customWidth?: number | null | undefined;
  customHeight?: number | null | undefined;
}

export interface Dimensions {
  width: number;
  height: number;
}

function toEven(n: number): number {
  return Math.max(2, Math.round(Math.round(n) / 2) * 2);
}

function requireCustom(value: number | null | undefined, name: string): number {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} is required (positive number) when aspectRatio or resolution is "custom"`);
  }
  return value;
}

function checkRange(dims: Dimensions): Dimensions {
  for (const [name, value] of [
    ['width', dims.width],
    ['height', dims.height],
  ] as const) {
    if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
      throw new RangeError(
        `Resolved ${name} ${value} px is outside [${MIN_DIMENSION}, ${MAX_DIMENSION}] (after rounding to an even integer)`,
      );
    }
  }
  return dims;
}

/**
 * `true` when `width × height` matches the preset aspect ratio up to rounding: there is an exact-ratio size
 * (t·w, t·h) with each side within ±1 px of the given one (what rounding each side to an even integer can cause).
 * Always `true` for `custom`.
 */
export function dimensionsMatchAspectRatio(width: number, height: number, aspectRatio: AspectRatio): boolean {
  if (aspectRatio === 'custom') return true;
  const { w, h } = ASPECT_RATIO_VALUES[aspectRatio];
  const low = Math.max((width - 1) / w, (height - 1) / h);
  const high = Math.min((width + 1) / w, (height + 1) / h);
  return low <= high;
}

/**
 * Resolves output pixel dimensions. Preset resolution = SHORT side in px; the long side is
 * round(short × ratio) rounded to even. `custom` aspect ratio or resolution requires both custom dims, which are
 * used as-is (rounded to even). With aspectRatio `custom` the resolution preset is IGNORED; with resolution `custom`
 * and a preset aspect ratio, `VideoRequestSchema` requires the custom size to match that ratio
 * (`dimensionsMatchAspectRatio`). Output is always even integers in [16, 8192].
 *
 * @throws RangeError when custom dims are missing / non-positive, or a resolved side falls outside [16, 8192].
 */
export function resolveDimensions(input: ResolveDimensionsInput): Dimensions {
  const { aspectRatio, resolution } = input;
  if (aspectRatio === 'custom' || resolution === 'custom') {
    const width = requireCustom(input.customWidth, 'customWidth');
    const height = requireCustom(input.customHeight, 'customHeight');
    return checkRange({ width: toEven(width), height: toEven(height) });
  }
  const short = RESOLUTION_SHORT_SIDE[resolution];
  const { w, h } = ASPECT_RATIO_VALUES[aspectRatio];
  if (w === h) return checkRange({ width: toEven(short), height: toEven(short) });
  if (w < h) return checkRange({ width: toEven(short), height: toEven((short * h) / w) });
  return checkRange({ width: toEven((short * w) / h), height: toEven(short) });
}

export const SampleRateSchema = z.union([z.literal(44100), z.literal(48000)]);
export type SampleRate = z.infer<typeof SampleRateSchema>;

export const VideoCodecSchema = z.enum(['h264', 'h265', 'vp9', 'prores']);
export type VideoCodec = z.infer<typeof VideoCodecSchema>;

export const AudioCodecSchema = z.enum(['aac', 'opus']);
export type AudioCodec = z.infer<typeof AudioCodecSchema>;

export const FpsSchema = z.number().int().min(1).max(240);
export type Fps = z.infer<typeof FpsSchema>;

export const RenderSettingsSchema = z.object({
  width: EvenDimensionSchema,
  height: EvenDimensionSchema,
  fps: FpsSchema,
  backgroundColor: HexColorSchema,
  sampleRate: SampleRateSchema,
  videoCodec: VideoCodecSchema,
  audioCodec: AudioCodecSchema,
});
export type RenderSettings = z.infer<typeof RenderSettingsSchema>;
