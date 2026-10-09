'use server';

import type { DirectorRunDTO } from '@vc/schema';
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { failureMessage } from '@/lib/api-failure';
import type { RunActionResult } from '@/lib/run-actions';
import { cancelDirectorRun, deleteProject, isStudioApiError, startDirectorRun } from '@/lib/studio-api';

async function runAction(call: () => Promise<DirectorRunDTO>): Promise<RunActionResult> {
  try {
    const run = await call();
    refresh();
    return { ok: true, run };
  } catch (error) {
    if (!isStudioApiError(error)) throw error;
    return { ok: false, code: error.code, message: failureMessage(error.toFailure()) };
  }
}

/** Starts (or re-runs) the AI Director for a project: `POST /v1/projects/:id/director-runs`. */
export async function startDirectorRunAction(projectId: string): Promise<RunActionResult> {
  return runAction(() => startDirectorRun(projectId));
}

/** Cancels a queued/running director run: `POST /v1/director-runs/:runId/cancel`. */
export async function cancelDirectorRunAction(runId: string): Promise<RunActionResult> {
  return runAction(() => cancelDirectorRun(runId));
}

/** Deletes a project (`DELETE /v1/projects/:id`; the API refuses with 409 while a run is active). */
export async function deleteProjectAction(projectId: string): Promise<RunActionResult> {
  try {
    await deleteProject(projectId);
  } catch (error) {
    if (!isStudioApiError(error)) throw error;
    return { ok: false, code: error.code, message: failureMessage(error.toFailure()) };
  }
  redirect('/projects');
}
