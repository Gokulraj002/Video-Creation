import type { EngineType } from '@vc/schema';

export interface EngineAvailabilityInfo {
  available: boolean;
  reason: string | null;
}

/** Engine availability passed to the AI Director (selection/coercion) and shown by /v1/system/config. */
export const STUDIO_ENGINE_AVAILABILITY: Readonly<Record<EngineType, EngineAvailabilityInfo>> = Object.freeze({
  // Available for PLANNING only: nothing renders in M1 (the renderer arrives in M2 for 2D, M5 for 3D).
  motion2d: { available: true, reason: 'Planned scenes only; rendering arrives in Milestone 2 (2D renderer)' },
  three: { available: true, reason: 'Planned scenes only; rendering arrives in Milestone 5 (3D engine)' },
  footage: { available: false, reason: 'requires uploaded assets (Milestone 3) and the footage engine (Milestone 6)' },
  image: { available: false, reason: 'requires uploaded assets (Milestone 3) and the image engine (Milestone 6)' },
  screen: { available: false, reason: 'requires uploaded assets (Milestone 3) and the screen engine (Milestone 6)' },
  generated: { available: false, reason: 'no video generation provider configured' },
});

const ENGINE_ORDER: readonly EngineType[] = ['motion2d', 'three', 'footage', 'image', 'screen', 'generated'];

export function engineAvailabilityList(
  availability: Readonly<Record<EngineType, EngineAvailabilityInfo>> = STUDIO_ENGINE_AVAILABILITY,
): { engine: EngineType; available: boolean; reason: string | null }[] {
  return ENGINE_ORDER.map((engine) => ({
    engine,
    available: availability[engine].available,
    reason: availability[engine].reason,
  }));
}
