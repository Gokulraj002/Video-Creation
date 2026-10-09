import { DbIdSchema } from '@vc/schema';
import type { ApiFailure } from '@/lib/api-failure';
import { getDirectorRun, isStudioApiError } from '@/lib/studio-api';

/**
 * Same-origin polling endpoint for the browser: proxies `GET /v1/director-runs/:runId` server-side so the API token
 * never reaches the client. Responses are validated `DirectorRunDTO`s or `{error: {code, message}}` envelopes.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function statusFor(failure: ApiFailure): number {
  switch (failure.kind) {
    case 'not_configured':
      return 503;
    case 'unreachable':
    case 'invalid_response':
      return 502;
    case 'unauthorized':
      return 502; // the web server's credentials were rejected — not the browser's
    case 'not_found':
      return 404;
    case 'http':
      return failure.status && failure.status >= 400 ? failure.status : 502;
  }
}

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await context.params;
  if (!DbIdSchema.safeParse(runId).success || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    return Response.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid run id.' } }, { status: 400, headers: NO_STORE });
  }
  try {
    const run = await getDirectorRun(runId);
    return Response.json(run, { headers: NO_STORE });
  } catch (error) {
    if (!isStudioApiError(error)) throw error;
    const failure = error.toFailure();
    return Response.json(
      { error: { code: failure.code, message: failure.message } },
      { status: statusFor(failure), headers: NO_STORE },
    );
  }
}
