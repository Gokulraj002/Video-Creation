import { z } from 'zod';
import { DurationFramesSchema, IdSchema, SafeUriSchema } from './common';

export const AssetKindSchema = z.enum(['image', 'video', 'audio', 'font', 'model3d', 'document', 'subtitle']);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetSourceSchema = z.enum(['upload', 'generated', 'stock', 'external']);
export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const MimeTypeSchema = z
  .string()
  .max(127)
  .regex(/^[\w.+-]+\/[\w.+-]+$/, 'Invalid MIME type, e.g. "image/png"');
export type MimeType = z.infer<typeof MimeTypeSchema>;

export const AssetRefSchema = z.object({
  id: IdSchema,
  kind: AssetKindSchema,
  uri: SafeUriSchema,
  mimeType: MimeTypeSchema,
  name: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  durationInFrames: DurationFramesSchema.optional(),
  source: AssetSourceSchema,
  provider: z.string().min(1).max(120).optional(),
  license: z.string().min(1).max(500).optional(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;
