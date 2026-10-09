import type { ClientRun } from './client-run';

/** Result of the project-page Server Actions (start / re-run / cancel / delete); runs in the slim client shape. */
export type RunActionResult = { ok: true; run: ClientRun | null } | { ok: false; code: string; message: string };

/** Human copy for error codes passed through the URL after project creation (`?runError=CODE`). */
export function runErrorNotice(code: string): string {
  switch (code) {
    case 'QUOTA_EXCEEDED':
      return 'The project was created, but the daily director quota is used up, so no run was started. Try again later.';
    case 'RUN_ACTIVE':
      return 'A director run was already active for this project.';
    case 'API_UNREACHABLE':
      return 'The project was created, but the Studio API became unreachable before the director run could start.';
    case 'RATE_LIMITED':
      return 'The project was created, but the request was rate limited before the director run could start.';
    default:
      return `The project was created, but the director run could not be started (${code}).`;
  }
}
