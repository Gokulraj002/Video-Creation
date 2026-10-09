import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, firstText, firstTextOrNull } from './helpers';
import { defineTemplate } from './types';

export const TitleCardPropsSchema = z.object({
  headline: z.string().min(1).max(120),
  subheadline: z.string().min(1).max(200).nullable(),
  align: z.enum(['left', 'center']),
  background: z.object({
    style: z.enum(['solid', 'gradient']),
    colors: z.array(HexColorSchema).min(1).max(3),
  }),
  accentColor: HexColorSchema,
});
export type TitleCardProps = z.infer<typeof TitleCardPropsSchema>;

export const titleCardTemplate = defineTemplate({
  id: 'title-card',
  engine: 'motion2d',
  name: 'Title card',
  description:
    'Full-frame headline with an optional subheadline over a solid or gradient background and a thin accent rule. ' +
    'Use for openings, chapter intros and section breaks.',
  genres: [
    'cinematic-ad',
    'promo',
    'sop-training',
    'corporate-training',
    'comedy',
    'cartoon',
    'motion-graphics',
    'product-3d',
    'real-estate',
    'explainer',
    'presentation',
    'social-short',
    'long-form',
    'reference-based',
  ],
  propsSchema: TitleCardPropsSchema,
  minDurationSeconds: 1.5,
  buildProps(ctx): TitleCardProps {
    const c = colorsOf(ctx);
    return {
      headline: firstText([ctx.title, ctx.brandName], 'Untitled', 120),
      subheadline: firstTextOrNull([ctx.text, ctx.brandName], 200),
      align: 'center',
      background: { style: 'gradient', colors: [c.background, c.primary] },
      accentColor: c.accent,
    };
  },
});
