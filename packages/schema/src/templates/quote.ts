import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, textOr, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const QuotePropsSchema = z.object({
  quote: z.string().min(1).max(400),
  attribution: z.string().min(1).max(120).nullable(),
  accentColor: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type QuoteProps = z.infer<typeof QuotePropsSchema>;

export const quoteTemplate = defineTemplate({
  id: 'quote',
  engine: 'motion2d',
  name: 'Quote',
  description:
    'A large pull quote with oversized quotation marks and an optional attribution line. ' +
    'Use for testimonials, mission statements and memorable lines.',
  genres: ['corporate-training', 'presentation', 'long-form', 'promo', 'explainer', 'cinematic-ad'],
  propsSchema: QuotePropsSchema,
  minDurationSeconds: 3,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    return {
      quote: textOr(ctx.text, ctx.title || 'Every great story starts with a single idea.', 400),
      attribution: textOrNull(ctx.brandName, 120),
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
