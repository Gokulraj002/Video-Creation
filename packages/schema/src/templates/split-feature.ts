import { z } from 'zod';
import { HexColorSchema, IdSchema } from '../common';
import { clip, colorsOf, firstText, hashString, textOr } from './helpers';
import { defineTemplate } from './types';

export const SplitFeaturePropsSchema = z.object({
  headline: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  mediaSide: z.enum(['left', 'right']),
  imageAssetId: IdSchema.nullable(),
  imagePrompt: z.string().min(1).max(500).nullable(),
  accentColor: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type SplitFeatureProps = z.infer<typeof SplitFeaturePropsSchema>;

export const splitFeatureTemplate = defineTemplate({
  id: 'split-feature',
  engine: 'motion2d',
  name: 'Split feature',
  description:
    'Split layout: headline and body copy on one side, an image (uploaded asset or a placeholder described by ' +
    'imagePrompt) on the other. Use to explain a feature, benefit or concept with a visual.',
  genres: ['promo', 'product-3d', 'explainer', 'presentation', 'real-estate', 'corporate-training', 'long-form'],
  propsSchema: SplitFeaturePropsSchema,
  minDurationSeconds: 4,
  buildProps(ctx): SplitFeatureProps {
    const c = colorsOf(ctx);
    const body = firstText([ctx.text, ctx.bullets.join('. '), ctx.title], 'Feature details', 500);
    return {
      headline: textOr(ctx.title, 'Feature', 120),
      body,
      mediaSide: hashString(ctx.title) % 2 === 0 ? 'right' : 'left',
      imageAssetId: null,
      imagePrompt: clip(`Illustration of ${textOr(ctx.title, 'the feature', 200)}`, 500),
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
