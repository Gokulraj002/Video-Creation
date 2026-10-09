import type { EngineType } from '@vc/schema';

export interface EngineAvailabilityInfo {
  available: boolean;
  reason: string | null;
}

/** Engines the studio can render in Milestone 1 (passed to the AI Director and shown by /v1/system/config). */
export const STUDIO_ENGINE_AVAILABILITY: Readonly<Record<EngineType, EngineAvailabilityInfo>> = Object.freeze({
  motion2d: { available: true, reason: null },
  three: { available: true, reason: null },
  footage: { available: false, reason: 'requires uploaded assets (Milestone 3)' },
  image: { available: false, reason: 'requires uploaded assets (Milestone 3)' },
  screen: { available: false, reason: 'requires uploaded assets (Milestone 3)' },
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
