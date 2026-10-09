import { z } from 'zod';
import { HexColorSchema } from '../common';
import { clip, colorsOf, pick, textOr } from './helpers';
import { defineTemplate } from './types';

export const KineticTextPropsSchema = z.object({
  lines: z.array(z.string().min(1).max(80)).min(1).max(6),
  emphasis: z.string().min(1).max(80).nullable(),
  style: z.enum(['bold', 'minimal', 'playful']),
  color: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type KineticTextProps = z.infer<typeof KineticTextPropsSchema>;

/** Splits text into lines of at most ~`perLine` words. */
function toLines(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  for (let i = 0; i < words.length && lines.length < maxLines; i += perLine) {
    const line = clip(words.slice(i, i + perLine).join(' '), 80);
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

export const kineticTextTemplate = defineTemplate({
  id: 'kinetic-text',
  engine: 'motion2d',
  name: 'Kinetic typography',
  description:
    'Short lines of large type that animate in one after another, with one emphasized word or phrase. ' +
    'Use for punchy statements, hooks and slogans (1-6 short lines).',
  genres: ['cinematic-ad', 'promo', 'motion-graphics', 'social-short', 'explainer', 'long-form', 'reference-based'],
  propsSchema: KineticTextPropsSchema,
  minDurationSeconds: 2,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const source = textOr(ctx.text, ctx.title || 'Make it move', 480);
    const lines = toLines(source, 4, 6);
    const longest = source
      .split(/\s+/)
      .reduce((best, w) => (w.length > best.length ? w : best), '')
      .replace(/[^\p{L}\p{N}'-]/gu, '');
    return {
      lines: lines.length > 0 ? lines : [textOr(ctx.title, 'Make it move', 80)],
      emphasis: longest.length > 0 ? clip(longest, 80) : null,
      style: pick(['bold', 'minimal', 'playful'], ctx.title),
      color: c.text,
      backgroundColor: c.background,
    };
  },
});
