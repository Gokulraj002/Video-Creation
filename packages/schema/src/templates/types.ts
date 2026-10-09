import type { z } from 'zod';
import type { VideoGenre } from '../director';

/** Context the deterministic `buildProps` uses to produce valid props (heuristic mock + engine-fallback coercion). */
export interface TemplatePropsContext {
  title: string;
  text: string | null;
  bullets: string[];
  /** Hex colors, at least 2 (invalid entries are ignored and defaults fill the gaps). */
  palette: string[];
  brandName: string | null;
}

export type TemplateEngine = 'motion2d' | 'three';

export interface TemplateDefinition<P extends z.ZodObject = z.ZodObject> {
  id: string;
  engine: TemplateEngine;
  name: string;
  /** What it looks like and when to use it (shown to the LLM). */
  description: string;
  genres: readonly VideoGenre[];
  /** LLM-safe: closed object, all properties required, nullable for optional, no records/recursion. */
  propsSchema: P;
  minDurationSeconds: number;
  buildProps(ctx: TemplatePropsContext): z.infer<P>;
}

/** Any catalog entry (props type erased). */
export type AnyTemplateDefinition = TemplateDefinition<z.ZodObject>;

/** Identity helper that keeps the precise props type of a template definition. */
export function defineTemplate<P extends z.ZodObject>(def: TemplateDefinition<P>): TemplateDefinition<P> {
  return def;
}
