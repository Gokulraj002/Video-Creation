import { ProjectStatus, RunStatus, type Prisma } from '../db';

export type RunOutcome = 'failed' | 'cancelled';

export const ACTIVE_RUN_STATUSES: RunStatus[] = [RunStatus.QUEUED, RunStatus.RUNNING];

/**
 * After a run stops without producing a version: READY if the project already has a version,
 * otherwise FAILED (run failed) or DRAFT (run cancelled). No-op while another run is active
 * (e.g. the user re-ran right after cancelling) so a late finaliser never clobbers DIRECTING.
 */
export async function restoreProjectStatus(
  tx: Prisma.TransactionClient,
  projectId: string,
  outcome: RunOutcome,
): Promise<void> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { currentVersionId: true },
  });
  if (project === null) return;
  const active = await tx.directorRun.count({
    where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (active > 0) return;
  const status =
    project.currentVersionId !== null
      ? ProjectStatus.READY
      : outcome === 'failed'
        ? ProjectStatus.FAILED
        : ProjectStatus.DRAFT;
  await tx.project.update({ where: { id: projectId }, data: { status } });
}
