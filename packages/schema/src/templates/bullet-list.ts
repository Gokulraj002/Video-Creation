import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, itemsOf, textOr } from './helpers';
import { defineTemplate } from './types';

export const BulletListPropsSchema = z.object({
  title: z.string().min(1).max(120),
  bullets: z.array(z.string().min(1).max(160)).min(1).max(6),
  marker: z.enum(['check', 'dot', 'number']),
  accentColor: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type BulletListProps = z.infer<typeof BulletListPropsSchema>;

export const bulletListTemplate = defineTemplate({
  id: 'bullet-list',
  engine: 'motion2d',
  name: 'Bullet list',
  description:
    'A title with 1-6 bullet points revealed one by one, using check, dot or number markers. ' +
    'Use for agendas, feature lists, key takeaways and summaries.',
  genres: ['sop-training', 'corporate-training', 'explainer', 'presentation', 'long-form', 'promo'],
  propsSchema: BulletListPropsSchema,
  minDurationSeconds: 4,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const bullets = itemsOf(ctx, 6, 160);
    return {
      title: textOr(ctx.title, 'Key points', 120),
      bullets,
      marker: bullets.length > 1 ? 'number' : 'check',
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
