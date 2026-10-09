import { toClientRun } from '@/lib/client-run';
import { errorResponse, isValidId, jsonError, jsonOk } from '@/lib/route-response';
import { getDirectorRun } from '@/lib/studio-api';

/**
 * Same-origin polling endpoint for the browser: proxies `GET /v1/director-runs/:runId` server-side so the API token
 * never reaches the client. Responses are validated runs in the slim `ClientRun` shape (usage totals only) or
 * `{error: {code, message}}` envelopes with generic messages (details are logged server-side): 400 invalid id,
 * 404 not found, 503 web app misconfigured / credentials rejected, 502 API unreachable, other API statuses as-is.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await context.params;
  if (!isValidId(runId)) return jsonError(400, 'VALIDATION_ERROR', 'Invalid run id.');
  try {
    return jsonOk(toClientRun(await getDirectorRun(runId)));
  } catch (error) {
    return errorResponse(error, 'GET /api/runs/:runId');
  }
}
