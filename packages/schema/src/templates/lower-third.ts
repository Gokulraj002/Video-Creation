import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, textOr, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const LowerThirdPropsSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(120).nullable(),
  accentColor: HexColorSchema,
});
export type LowerThirdProps = z.infer<typeof LowerThirdPropsSchema>;

export const lowerThirdTemplate = defineTemplate({
  id: 'lower-third',
  engine: 'motion2d',
  name: 'Lower third',
  description:
    'A name/role strip that slides in at the bottom-left of the frame. Usable as a scene or as an overlay. ' +
    'Use to introduce a speaker, a location or a topic label.',
  genres: ['corporate-training', 'presentation', 'long-form', 'sop-training', 'explainer', 'real-estate', 'promo'],
  propsSchema: LowerThirdPropsSchema,
  minDurationSeconds: 2,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    return {
      name: textOr(ctx.title, ctx.brandName ?? 'Speaker', 80),
      role: textOrNull(ctx.text ?? ctx.brandName, 120),
      accentColor: c.accent,
    };
  },
});
