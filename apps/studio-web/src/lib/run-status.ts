import type { DirectorRunProgress, DirectorRunStatus, DirectorStage, ProjectStatus } from '@vc/schema';
import type { BadgeVariant } from '@/components/ui/badge';

/** Status presentation + small pure predicates shared by server and client components. */

export function isActiveRunStatus(status: DirectorRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

export const RUN_STATUS_META: Readonly<Record<DirectorRunStatus, { label: string; variant: BadgeVariant }>> = {
  queued: { label: 'Queued', variant: 'info' },
  running: { label: 'Running', variant: 'info' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
};

export const PROJECT_STATUS_META: Readonly<Record<ProjectStatus, { label: string; variant: BadgeVariant }>> = {
  draft: { label: 'Draft', variant: 'muted' },
  directing: { label: 'Directing', variant: 'info' },
  ready: { label: 'Ready', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
};

export const STAGE_LABELS: Readonly<Record<DirectorStage, string>> = {
  brief: 'Creative brief',
  outline: 'Outline',
  script: 'Script',
  storyboard: 'Storyboard',
  shotList: 'Shot list',
  engineSelection: 'Engine selection',
  sceneSpecs: 'Scene specs',
  compile: 'Compile timeline',
};

/** Progress percentage 0..100 (succeeded runs are always 100). */
export function runProgressPercent(progress: DirectorRunProgress, status?: DirectorRunStatus): number {
  if (status === 'succeeded') return 100;
  if (progress.totalSteps <= 0) return 0;
  const pct = (progress.completedSteps / progress.totalSteps) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
