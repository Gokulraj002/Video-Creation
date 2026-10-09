import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, pick, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const CartoonScenePropsSchema = z.object({
  character: z.enum(['blob', 'robot', 'cat', 'bird']),
  expression: z.enum(['happy', 'surprised', 'confused', 'angry', 'laughing']),
  dialogue: z.string().min(1).max(200).nullable(),
  setting: z.enum(['room', 'office', 'park', 'space', 'stage']),
  gag: z.enum(['none', 'bounce', 'shake', 'spin', 'squash']),
  backgroundColor: HexColorSchema,
});
export type CartoonSceneProps = z.infer<typeof CartoonScenePropsSchema>;

export const cartoonSceneTemplate = defineTemplate({
  id: 'cartoon-scene',
  engine: 'motion2d',
  name: 'Cartoon scene',
  description:
    'A flat vector cartoon character (blob, robot, cat or bird) with an expression, a speech bubble and a ' +
    'physical gag in a simple setting. Use for comedy, cartoons and light-hearted moments.',
  genres: ['comedy', 'cartoon', 'social-short', 'explainer'],
  propsSchema: CartoonScenePropsSchema,
  minDurationSeconds: 3,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const seed = `${ctx.title}|${ctx.text ?? ''}`;
    return {
      character: pick(['blob', 'robot', 'cat', 'bird'], `${seed}|character`),
      expression: pick(['happy', 'surprised', 'confused', 'angry', 'laughing'], `${seed}|expression`),
      dialogue: textOrNull(ctx.text ?? ctx.title, 200),
      setting: pick(['room', 'office', 'park', 'space', 'stage'], `${seed}|setting`),
      gag: pick(['bounce', 'shake', 'spin', 'squash'], `${seed}|gag`),
      backgroundColor: c.primary,
    };
  },
});
