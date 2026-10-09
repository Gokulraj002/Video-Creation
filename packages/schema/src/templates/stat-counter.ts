import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, firstNumber, textOr } from './helpers';
import { defineTemplate } from './types';

export const StatCounterPropsSchema = z.object({
  value: z.number().min(-1e15).max(1e15),
  decimals: z.number().int().min(0).max(3),
  prefix: z.string().min(1).max(8).nullable(),
  suffix: z.string().min(1).max(16).nullable(),
  label: z.string().min(1).max(120),
  accentColor: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type StatCounterProps = z.infer<typeof StatCounterPropsSchema>;

export const statCounterTemplate = defineTemplate({
  id: 'stat-counter',
  engine: 'motion2d',
  name: 'Stat counter',
  description:
    'A big number that counts up from zero to the value, with optional prefix/suffix (e.g. "$", "%") and a label. ' +
    'Use for key metrics, results and impressive figures.',
  genres: ['promo', 'corporate-training', 'explainer', 'presentation', 'motion-graphics', 'social-short', 'long-form'],
  propsSchema: StatCounterPropsSchema,
  minDurationSeconds: 2.5,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const source = [ctx.text ?? '', ...ctx.bullets, ctx.title].join(' ');
    const found = firstNumber(source);
    const value = found ? Math.max(-1e15, Math.min(1e15, found.value)) : 100;
    return {
      value,
      decimals: found ? found.decimals : 0,
      prefix: null,
      suffix: found ? found.suffix : '%',
      label: textOr(ctx.title, 'Growth', 120),
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
