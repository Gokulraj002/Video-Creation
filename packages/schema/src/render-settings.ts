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

/**
 * Resolves output pixel dimensions. Preset resolution = SHORT side in px; the long side is
 * round(short × ratio) rounded to even. `custom` aspect ratio or resolution requires both custom dims.
 * Output is always even integers.
 */
export function resolveDimensions(input: ResolveDimensionsInput): Dimensions {
  const { aspectRatio, resolution } = input;
  if (aspectRatio === 'custom' || resolution === 'custom') {
    const width = requireCustom(input.customWidth, 'customWidth');
    const height = requireCustom(input.customHeight, 'customHeight');
    return { width: toEven(width), height: toEven(height) };
  }
  const short = RESOLUTION_SHORT_SIDE[resolution];
  const { w, h } = ASPECT_RATIO_VALUES[aspectRatio];
  if (w === h) return { width: toEven(short), height: toEven(short) };
  if (w < h) return { width: toEven(short), height: toEven((short * h) / w) };
  return { width: toEven((short * w) / h), height: toEven(short) };
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
