import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, textOr, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const CtaEndCardPropsSchema = z.object({
  headline: z.string().min(1).max(120),
  callToAction: z.string().min(1).max(120),
  contactLine: z.string().min(1).max(160).nullable(),
  accentColor: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type CtaEndCardProps = z.infer<typeof CtaEndCardPropsSchema>;

export const ctaEndCardTemplate = defineTemplate({
  id: 'cta-end-card',
  engine: 'motion2d',
  name: 'Call-to-action end card',
  description:
    'Closing card with a headline, a prominent call-to-action button and an optional contact line (URL, phone). ' +
    'Use as the final scene when there is a call to action.',
  genres: [
    'cinematic-ad',
    'promo',
    'social-short',
    'product-3d',
    'real-estate',
    'explainer',
    'motion-graphics',
    'reference-based',
    'corporate-training',
    'presentation',
  ],
  propsSchema: CtaEndCardPropsSchema,
  minDurationSeconds: 2.5,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    return {
      headline: textOr(ctx.brandName ?? ctx.title, 'Thank you', 120),
      callToAction: textOr(ctx.text ?? ctx.bullets[0], 'Learn more', 120),
      contactLine: textOrNull(ctx.bullets[1], 160),
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
