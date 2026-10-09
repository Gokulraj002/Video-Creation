import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, textOr, textOrNull } from './helpers';
import { defineTemplate } from './types';

export const StepInstructionPropsSchema = z
  .object({
    stepNumber: z.number().int().min(1).max(999),
    totalSteps: z.number().int().min(1).max(999),
    title: z.string().min(1).max(120),
    instruction: z.string().min(1).max(500),
    caution: z.string().min(1).max(200).nullable(),
    accentColor: HexColorSchema,
    backgroundColor: HexColorSchema,
  })
  .refine((p) => p.stepNumber <= p.totalSteps, {
    path: ['stepNumber'],
    message: 'stepNumber must be <= totalSteps',
  });
export type StepInstructionProps = z.infer<typeof StepInstructionPropsSchema>;

const CAUTION_HINT = /\b(caution|warning|danger|careful|never|do not|don't|avoid|ensure|safety)\b/i;

export const stepInstructionTemplate = defineTemplate({
  id: 'step-instruction',
  engine: 'motion2d',
  name: 'SOP step',
  description:
    'A numbered procedure step ("Step 2 of 5") with a title, a clear instruction and an optional caution banner. ' +
    'Use for SOPs, onboarding and how-to training, one step per scene.',
  genres: ['sop-training', 'corporate-training', 'explainer'],
  propsSchema: StepInstructionPropsSchema,
  minDurationSeconds: 4,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const caution = ctx.bullets.find((b) => CAUTION_HINT.test(b)) ?? null;
    const totalSteps = Math.min(999, Math.max(1, ctx.bullets.length));
    return {
      stepNumber: 1,
      totalSteps,
      title: textOr(ctx.title, 'Step', 120),
      instruction: textOr(ctx.text ?? ctx.bullets[0], ctx.title || 'Follow the procedure.', 500),
      caution: textOrNull(caution, 200),
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
