import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, textOr } from './helpers';
import { defineTemplate } from './types';

export const LogoReveal3DPropsSchema = z.object({
  text: z.string().min(1).max(40),
  depth: z.number().min(0.05).max(2),
  color: HexColorSchema,
  accentColor: HexColorSchema,
});
export type LogoReveal3DProps = z.infer<typeof LogoReveal3DPropsSchema>;

export const logoReveal3DTemplate = defineTemplate({
  id: 'logo-reveal-3d',
  engine: 'three',
  name: 'Logo reveal (3D)',
  description:
    'Extruded 3D wordmark that flies in and settles with a light sweep and accent glow. ' +
    'Use for brand openers and closers (short text: brand or product name).',
  genres: ['product-3d', 'cinematic-ad', 'promo', 'motion-graphics', 'corporate-training'],
  propsSchema: LogoReveal3DPropsSchema,
  minDurationSeconds: 2.5,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    return {
      text: textOr(ctx.brandName ?? ctx.title, 'Brand', 40),
      depth: 0.4,
      color: c.primary,
      accentColor: c.accent,
    };
  },
});
