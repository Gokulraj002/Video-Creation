import { z } from 'zod';
import { DurationFramesSchema, FrameSchema, IdSchema } from './common';

export const ChapterSchema = z.object({
  id: IdSchema,
  title: z.string().max(200),
  summary: z.string().max(2000).optional(),
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
});
export type Chapter = z.infer<typeof ChapterSchema>;
