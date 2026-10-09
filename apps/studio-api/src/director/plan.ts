import { planStructure, totalStepsFor, type StructurePlan } from '@vc/ai-director';
import { VideoRequestSchema, type ResourceLimits } from '@vc/schema';

/**
 * Deterministic structure plan of a stored project request, or null when it no longer plans (invalid request,
 * or the limits were lowered since the project was created); the run then fails properly in the worker.
 */
export function plannedStructure(storedRequest: unknown, limits: ResourceLimits): StructurePlan | null {
  const parsed = VideoRequestSchema.safeParse(storedRequest);
  if (!parsed.success) return null;
  try {
    return planStructure(parsed.data, [], limits);
  } catch {
    return null;
  }
}

/** Total director steps for a stored project request (so a QUEUED run already shows "0 / N"); 0 if it does not plan. */
export function plannedTotalSteps(storedRequest: unknown, limits: ResourceLimits): number {
  const plan = plannedStructure(storedRequest, limits);
  return plan === null ? 0 : totalStepsFor(plan);
}
