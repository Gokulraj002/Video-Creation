import { z } from 'zod';
import {
  DurationFramesSchema,
  FrameSchema,
  IdSchema,
  JsonObjectSchema,
  NormalizedSchema,
  TemplateIdSchema,
} from './common';
import { FitSchema, Layer2DSchema } from './layers';

export const EngineTypeSchema = z.enum(['motion2d', 'three', 'footage', 'generated', 'image', 'screen']);
export type EngineType = z.infer<typeof EngineTypeSchema>;

export const PlaybackRateSchema = z.number().min(0.25).max(4);

export const Motion2DContentSchema = z.object({
  engine: z.literal('motion2d'),
  template: TemplateIdSchema,
  props: JsonObjectSchema,
  layers: z.array(Layer2DSchema).max(500).default([]),
});
export type Motion2DContent = z.infer<typeof Motion2DContentSchema>;

export const ThreeEnvironmentSchema = z.enum(['studio', 'sunset', 'city', 'night', 'forest', 'warehouse']);
export type ThreeEnvironment = z.infer<typeof ThreeEnvironmentSchema>;

export const ThreeLightingSchema = z.enum(['soft', 'dramatic', 'high-key']);
export type ThreeLighting = z.infer<typeof ThreeLightingSchema>;

export const ThreeContentSchema = z.object({
  engine: z.literal('three'),
  template: TemplateIdSchema,
  props: JsonObjectSchema,
  modelAssetId: IdSchema.optional(),
  environment: ThreeEnvironmentSchema,
  lighting: ThreeLightingSchema,
});
export type ThreeContent = z.infer<typeof ThreeContentSchema>;

export const FootageContentSchema = z.object({
  engine: z.literal('footage'),
  assetId: IdSchema,
  trimStartFrame: FrameSchema,
  playbackRate: PlaybackRateSchema,
  fit: FitSchema,
  volume: z.number().min(0).max(1),
  muted: z.boolean(),
});
export type FootageContent = z.infer<typeof FootageContentSchema>;

export const GenerationStatusSchema = z.enum(['pending', 'queued', 'ready', 'failed']);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;

export const GeneratedContentSchema = z.object({
  engine: z.literal('generated'),
  provider: IdSchema,
  prompt: z.string().max(4000),
  negativePrompt: z.string().max(4000).optional(),
  seed: z.number().int().optional(),
  status: GenerationStatusSchema,
  assetId: IdSchema.optional(),
  jobId: z.string().min(1).max(256).optional(),
});
export type GeneratedContent = z.infer<typeof GeneratedContentSchema>;

export const ImageAnimationSchema = z.enum(['none', 'ken-burns', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'parallax']);
export type ImageAnimation = z.infer<typeof ImageAnimationSchema>;

export const FocalPointSchema = z.object({ x: NormalizedSchema, y: NormalizedSchema });
export type FocalPoint = z.infer<typeof FocalPointSchema>;

export const ImageContentSchema = z.object({
  engine: z.literal('image'),
  assetId: IdSchema,
  animation: ImageAnimationSchema,
  fit: FitSchema,
  focalPoint: FocalPointSchema,
});
export type ImageContent = z.infer<typeof ImageContentSchema>;

export const ZoomRegionSchema = z.object({
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  x: NormalizedSchema,
  y: NormalizedSchema,
  width: NormalizedSchema,
  height: NormalizedSchema,
});
export type ZoomRegion = z.infer<typeof ZoomRegionSchema>;

export const ScreenContentSchema = z.object({
  engine: z.literal('screen'),
  assetId: IdSchema,
  trimStartFrame: FrameSchema,
  playbackRate: PlaybackRateSchema,
  zoomRegions: z.array(ZoomRegionSchema).max(200),
  highlightCursor: z.boolean(),
});
export type ScreenContent = z.infer<typeof ScreenContentSchema>;

export const SceneContentSchema = z.discriminatedUnion('engine', [
  Motion2DContentSchema,
  ThreeContentSchema,
  FootageContentSchema,
  GeneratedContentSchema,
  ImageContentSchema,
  ScreenContentSchema,
]);
export type SceneContent = z.infer<typeof SceneContentSchema>;

/** Content allowed on overlay track items (motion2d or image). */
export const OverlayContentSchema = z.discriminatedUnion('engine', [Motion2DContentSchema, ImageContentSchema]);
export type OverlayContent = z.infer<typeof OverlayContentSchema>;
