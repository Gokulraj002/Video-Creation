import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const ProductTurntablePropsSchema = z.object({
  primitive: z.enum(['box', 'cylinder', 'sphere', 'bottle', 'phone', 'can']),
  color: HexColorSchema,
  metalness: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1),
  headline: z.string().min(1).max(120).nullable(),
  rotationTurns: z.number().min(0.25).max(4),
});
export type ProductTurntableProps = z.infer<typeof ProductTurntablePropsSchema>;

const PRIMITIVE_HINTS: readonly [RegExp, ProductTurntableProps['primitive']][] = [
  [/\b(phone|smartphone|mobile|tablet|device|app)\b/i, 'phone'],
  [/\b(bottle|perfume|serum|wine|water|drink)\b/i, 'bottle'],
  [/\b(can|soda|beer|energy)\b/i, 'can'],
  [/\b(ball|sphere|globe|orb|planet)\b/i, 'sphere'],
  [/\b(cup|mug|candle|tube|cylinder|jar)\b/i, 'cylinder'],
];

export const productTurntableTemplate = defineTemplate({
  id: 'product-turntable',
  engine: 'three',
  name: 'Product turntable (3D)',
  description:
    'A stylized 3D product (box, cylinder, sphere, bottle, phone or can primitive, or an uploaded model) rotating ' +
    'on a turntable under studio lighting with an optional headline. Use for product hero shots.',
  genres: ['product-3d', 'promo', 'cinematic-ad', 'social-short'],
  propsSchema: ProductTurntablePropsSchema,
  minDurationSeconds: 3,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const haystack = `${ctx.title} ${ctx.text ?? ''} ${ctx.bullets.join(' ')}`;
    const primitive = PRIMITIVE_HINTS.find(([re]) => re.test(haystack))?.[1] ?? 'box';
    return {
      primitive,
      color: c.primary,
      metalness: 0.4,
      roughness: 0.3,
      headline: textOrNull(ctx.title, 120),
      rotationTurns: 1,
    };
  },
});
