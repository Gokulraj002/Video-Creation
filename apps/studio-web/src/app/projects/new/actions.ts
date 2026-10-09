'use server';

import { redirect } from 'next/navigation';
import { failureMessage } from '@/lib/api-failure';
import { apiErrorDetailsToFieldErrors, parseProjectForm } from '@/lib/project-form';
import type { CreateProjectFormState } from '@/lib/project-form-state';
import { createProject, isStudioApiError, startDirectorRun } from '@/lib/studio-api';

/**
 * Server Action behind the "New project" form: validates with `VideoRequestSchema`, creates the project, starts
 * the first director run and redirects to the project page. The API token never leaves the server.
 */
export async function createProjectAction(
  _previous: CreateProjectFormState,
  formData: FormData,
): Promise<CreateProjectFormState> {
  const parsed = parseProjectForm(formData);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: parsed.fieldErrors, formError: parsed.formError };
  }

  let projectId: string;
  try {
    const project = await createProject(parsed.request);
    projectId = project.id;
  } catch (error) {
    if (!isStudioApiError(error)) throw error;
    const failure = error.toFailure();
    return {
      status: 'error',
      fieldErrors: apiErrorDetailsToFieldErrors(error.details),
      formError: failureMessage(failure),
    };
  }

  let runErrorCode: string | null = null;
  try {
    await startDirectorRun(projectId);
  } catch (error) {
    if (!isStudioApiError(error)) throw error;
    runErrorCode = error.code;
  }

  const target = `/projects/${encodeURIComponent(projectId)}`;
  redirect(runErrorCode ? `${target}?runError=${encodeURIComponent(runErrorCode)}` : target);
}
