import { z } from 'zod';
import { EasingSchema } from './common';

export const TransitionTypeSchema = z.enum([
  'cut',
  'fade',
  'crossfade',
  'slide',
  'wipe',
  'zoom',
  'blur',
  'dip-to-black',
  'dip-to-white',
]);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

export const TransitionDirectionSchema = z.enum(['left', 'right', 'up', 'down']);
export type TransitionDirection = z.infer<typeof TransitionDirectionSchema>;

/** Transition INTO a scene. `cut` ⇔ `durationInFrames === 0`. */
export const TransitionSchema = z
  .object({
    type: TransitionTypeSchema,
    durationInFrames: z.number().int().min(0),
    direction: TransitionDirectionSchema.optional(),
    easing: EasingSchema,
  })
  .superRefine((t, ctx) => {
    if (t.type === 'cut' && t.durationInFrames !== 0) {
      ctx.addIssue({ code: 'custom', path: ['durationInFrames'], message: 'A "cut" transition must have durationInFrames 0' });
    }
    if (t.type !== 'cut' && t.durationInFrames === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationInFrames'],
        message: `A "${t.type}" transition must have durationInFrames > 0 (use "cut" for 0)`,
      });
    }
  });
export type Transition = z.infer<typeof TransitionSchema>;
