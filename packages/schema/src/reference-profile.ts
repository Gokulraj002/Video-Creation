import { z } from 'zod';
import { HexColorSchema, IdSchema, IsoDateTimeSchema, LanguageTagSchema, NormalizedSchema } from './common';
import { CameraMovementSchema, ShotTypeSchema } from './director';
import { TransitionTypeSchema } from './transitions';

const SecondsSchema = z.number().min(0);

export const ReferenceKindSchema = z.enum(['video', 'image', 'document', 'audio', 'script']);
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;

export const ReferenceMetadataSchema = z.object({
  durationSeconds: SecondsSchema.optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  fps: z.number().gt(0).max(1000).optional(),
  videoCodec: z.string().min(1).max(64).optional(),
  audioCodec: z.string().min(1).max(64).optional(),
  hasAudio: z.boolean().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  pageCount: z.number().int().min(0).optional(),
});
export type ReferenceMetadata = z.infer<typeof ReferenceMetadataSchema>;

export const ReferenceSceneSchema = z
  .object({
    index: z.number().int().min(0),
    startSeconds: SecondsSchema,
    endSeconds: SecondsSchema,
    keyframeAssetIds: z.array(IdSchema).max(50),
    shotType: ShotTypeSchema.optional(),
    cameraMovement: CameraMovementSchema.optional(),
    description: z.string().max(1000).optional(),
    dominantColors: z.array(HexColorSchema).max(16),
  })
  .refine((s) => s.endSeconds >= s.startSeconds, {
    path: ['endSeconds'],
    message: 'endSeconds must be >= startSeconds',
  });
export type ReferenceScene = z.infer<typeof ReferenceSceneSchema>;

export const PaletteEntrySchema = z.object({ hex: HexColorSchema, weight: NormalizedSchema });
export type PaletteEntry = z.infer<typeof PaletteEntrySchema>;

export const ReferenceTypographySchema = z.object({
  fontsDetected: z.array(z.string().min(1).max(120)).max(50),
  styleNotes: z.string().max(2000).optional(),
});
export type ReferenceTypography = z.infer<typeof ReferenceTypographySchema>;

export const TransitionStatSchema = z.object({ type: TransitionTypeSchema, count: z.number().int().min(0) });
export type TransitionStat = z.infer<typeof TransitionStatSchema>;

export const PacingSchema = z.object({
  averageShotSeconds: z.number().gt(0),
  cutsPerMinute: z.number().min(0),
});
export type Pacing = z.infer<typeof PacingSchema>;

export const TranscriptSegmentSchema = z.object({
  startSeconds: SecondsSchema,
  endSeconds: SecondsSchema,
  text: z.string().max(2000),
  speaker: z.string().min(1).max(120).optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  language: LanguageTagSchema,
  segments: z.array(TranscriptSegmentSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const ReferenceAudioSchema = z.object({
  hasMusic: z.boolean(),
  hasVoice: z.boolean(),
  tempoBpm: z.number().gt(0).max(400).optional(),
  loudnessLufs: z.number().min(-100).max(10).optional(),
});
export type ReferenceAudio = z.infer<typeof ReferenceAudioSchema>;

/** Produced by the M3 analysis engine; consumed by the director now. */
export const ReferenceProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  assetId: IdSchema,
  kind: ReferenceKindSchema,
  createdAt: IsoDateTimeSchema,
  metadata: ReferenceMetadataSchema,
  scenes: z.array(ReferenceSceneSchema),
  palette: z.array(PaletteEntrySchema).max(16),
  typography: ReferenceTypographySchema.optional(),
  transitions: z.array(TransitionStatSchema),
  pacing: PacingSchema.optional(),
  transcript: TranscriptSchema.optional(),
  audio: ReferenceAudioSchema.optional(),
  styleSummary: z.string().max(2000).optional(),
  moodTags: z.array(z.string().min(1).max(64)).max(20),
  warnings: z.array(z.string().max(1000)),
});
export type ReferenceProfile = z.infer<typeof ReferenceProfileSchema>;
