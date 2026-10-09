import { z } from 'zod';
import { HexColorSchema } from '../common';
import { hashString, paletteOf, pick, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const FloatingShapesPropsSchema = z.object({
  shapes: z.enum(['spheres', 'cubes', 'torus', 'mixed']),
  count: z.number().int().min(3).max(40),
  palette: z.array(HexColorSchema).min(2).max(5),
  headline: z.string().min(1).max(120).nullable(),
});
export type FloatingShapesProps = z.infer<typeof FloatingShapesPropsSchema>;

export const floatingShapesTemplate = defineTemplate({
  id: 'floating-shapes',
  engine: 'three',
  name: 'Floating shapes (3D)',
  description:
    'Abstract 3D scene of softly floating spheres, cubes or tori in the brand palette with an optional headline. ' +
    'Use for abstract backgrounds, transitions between ideas and motion-graphics moments.',
  genres: ['motion-graphics', 'product-3d', 'promo', 'social-short', 'cinematic-ad', 'presentation'],
  propsSchema: FloatingShapesPropsSchema,
  minDurationSeconds: 2,
  buildProps(ctx) {
    const palette = paletteOf(ctx).slice(0, 5);
    return {
      shapes: pick(['spheres', 'cubes', 'torus', 'mixed'], ctx.title),
      count: 8 + (hashString(ctx.title) % 17),
      palette,
      headline: textOrNull(ctx.title, 120),
    };
  },
});
