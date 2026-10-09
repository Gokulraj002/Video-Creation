import type { EngineChoice, EngineType, VideoGenre } from '@vc/schema';
import { coercionTemplateFor } from './genres';
import type { EngineOption } from './stages';
import { clip } from './util/text';

export interface EngineStatus {
  available: boolean;
  reason: string | null;
}

export type EngineAvailability = Record<EngineType, EngineStatus>;

/** Engines the M1 compiler can render (the others are always coerced to motion2d). */
export const COMPILABLE_ENGINES: ReadonlySet<EngineType> = new Set<EngineType>(['motion2d', 'three']);

export const DEFAULT_ENGINE_AVAILABILITY: Readonly<EngineAvailability> = Object.freeze({
  motion2d: { available: true, reason: null },
  three: { available: true, reason: null },
  footage: { available: false, reason: 'no assets' },
  image: { available: false, reason: 'no assets' },
  screen: { available: false, reason: 'no assets' },
  generated: { available: false, reason: 'no video provider configured' },
});

const ENGINE_ORDER: readonly EngineType[] = ['motion2d', 'three', 'footage', 'image', 'screen', 'generated'];

export function resolveEngineAvailability(overrides: Partial<EngineAvailability> = {}): EngineAvailability {
  const out = {} as EngineAvailability;
  for (const engine of ENGINE_ORDER) {
    const status = overrides[engine] ?? DEFAULT_ENGINE_AVAILABILITY[engine];
    // Only motion2d/three can be compiled in M1; anything else stays unavailable for selection.
    out[engine] = COMPILABLE_ENGINES.has(engine)
      ? { available: status.available, reason: status.available ? null : (status.reason ?? 'disabled') }
      : { available: false, reason: status.available ? 'not supported by the M1 compiler' : (status.reason ?? 'unavailable') };
  }
  return out;
}

export function engineOptions(availability: EngineAvailability): EngineOption[] {
  return ENGINE_ORDER.map((engine) => ({ engine, ...availability[engine] }));
}

export interface CoercionContext {
  genre: VideoGenre;
  availability: EngineAvailability;
  isFirst: boolean;
  isLast: boolean;
  hasCallToAction: boolean;
}

export interface CoercionResult {
  choice: EngineChoice;
  warning: string | null;
}

/**
 * Deterministic coercion: a choice whose engine is unavailable becomes `motion2d` with a genre-appropriate
 * template (`title-card` first, `cta-end-card` last when a CTA exists, else the genre default) plus a warning.
 */
export function coerceEngineChoice(choice: EngineChoice, ctx: CoercionContext): CoercionResult {
  const status = ctx.availability[choice.engine];
  if (status.available && COMPILABLE_ENGINES.has(choice.engine)) return { choice, warning: null };
  const template = coercionTemplateFor(ctx.genre, ctx);
  const reason = status.reason ?? 'unavailable';
  return {
    choice: {
      sceneId: choice.sceneId,
      engine: 'motion2d',
      template,
      provider: null,
      rationale: clip(`Coerced from "${choice.engine}" (${reason}). ${choice.rationale}`, 500),
    },
    warning: `Scene "${choice.sceneId}": engine "${choice.engine}" is unavailable (${reason}); using motion2d template "${template}" instead.`,
  };
}
