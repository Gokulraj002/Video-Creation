import { planStructure, totalStepsFor } from '@vc/ai-director';
import { VideoRequestSchema, type ResourceLimits } from '@vc/schema';

/**
 * Total director steps for a stored project request (so a QUEUED run already shows "0 / N").
 * Returns 0 when the request no longer plans (e.g. limits were lowered); the run then fails properly.
 */
export function plannedTotalSteps(storedRequest: unknown, limits: ResourceLimits): number {
  const parsed = VideoRequestSchema.safeParse(storedRequest);
  if (!parsed.success) return 0;
  try {
    return totalStepsFor(planStructure(parsed.data, [], limits));
  } catch {
    return 0;
  }
}
