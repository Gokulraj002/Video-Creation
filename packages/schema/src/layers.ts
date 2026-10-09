import { z } from 'zod';
import {
  DurationFramesSchema,
  FontFamilySchema,
  FrameSchema,
  HexColorSchema,
  IdSchema,
  NormalizedSchema,
} from './common';

export const AnimationPresetSchema = z.enum([
  'none',
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'scale',
  'pop',
  'typewriter',
  'blur-in',
]);
export type AnimationPreset = z.infer<typeof AnimationPresetSchema>;

export const FitSchema = z.enum(['cover', 'contain']);
export type Fit = z.infer<typeof FitSchema>;

/** Fields shared by every 2D layer. `startFrame` is RELATIVE to the scene start. */
const layerBaseShape = {
  id: IdSchema,
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  enter: AnimationPresetSchema,
  exit: AnimationPresetSchema,
  opacity: NormalizedSchema,
};

export const TextLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal('text'),
  text: z.string().max(2000),
  /** Normalized center position. */
  x: NormalizedSchema,
  y: NormalizedSchema,
  maxWidth: NormalizedSchema,
  fontFamily: FontFamilySchema.optional(),
  /** Pixels at a 1080 px short side; renderers scale proportionally. */
  fontSize: z.number().min(4).max(400),
  fontWeight: z.number().int().min(100).max(900),
  color: HexColorSchema,
  align: z.enum(['left', 'center', 'right']),
});
export type TextLayer = z.infer<typeof TextLayerSchema>;

export const ShapeLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'circle', 'line']),
  x: NormalizedSchema,
  y: NormalizedSchema,
  width: NormalizedSchema,
  height: NormalizedSchema,
  color: HexColorSchema,
  cornerRadius: z.number().min(0),
});
export type ShapeLayer = z.infer<typeof ShapeLayerSchema>;

export const ImageLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal('image'),
  assetId: IdSchema,
  x: NormalizedSchema,
  y: NormalizedSchema,
  width: NormalizedSchema,
  height: NormalizedSchema,
  fit: FitSchema,
});
export type ImageLayer = z.infer<typeof ImageLayerSchema>;

export const Layer2DSchema = z.discriminatedUnion('type', [TextLayerSchema, ShapeLayerSchema, ImageLayerSchema]);
export type Layer2D = z.infer<typeof Layer2DSchema>;
