import { z } from 'zod';
import { DurationFramesSchema, FrameSchema, IdSchema, LanguageTagSchema } from './common';
import { CameraTrackSchema } from './camera';
import { SceneContentSchema } from './scene-content';
import { TransitionSchema } from './transitions';

export const NarrationSchema = z.object({
  text: z.string().max(5000),
  voiceId: z.string().min(1).max(128).optional(),
  language: LanguageTagSchema.optional(),
});
export type Narration = z.infer<typeof NarrationSchema>;

/** A scene; `startFrame` is absolute (timeline frames); camera/layer frames inside are relative to it. */
export const SceneSchema = z.object({
  id: IdSchema,
  chapterId: IdSchema,
  title: z.string().max(200),
  startFrame: FrameSchema,
  durationInFrames: DurationFramesSchema,
  content: SceneContentSchema,
  camera: CameraTrackSchema.optional(),
  transitionIn: TransitionSchema.optional(),
  narration: NarrationSchema.optional(),
  notes: z.string().max(2000).optional(),
  storyboardSceneId: z.string().min(1).max(128).optional(),
});
export type Scene = z.infer<typeof SceneSchema>;
