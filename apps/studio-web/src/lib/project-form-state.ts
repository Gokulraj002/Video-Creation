import type { FieldErrors } from './project-form';

/** State returned by `createProjectAction` (via `useActionState`). Success redirects, so it has no success variant. */
export type CreateProjectFormState =
  | { status: 'idle' }
  | { status: 'error'; fieldErrors: FieldErrors; formError: string | null };

export const INITIAL_CREATE_PROJECT_STATE: CreateProjectFormState = { status: 'idle' };
