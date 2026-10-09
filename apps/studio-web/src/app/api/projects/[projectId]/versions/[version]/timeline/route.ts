import { errorResponse, isValidId, jsonError, jsonOk, parseVersionParam } from '@/lib/route-response';
import { getProjectVersion } from '@/lib/studio-api';

/**
 * `GET /api/projects/:projectId/versions/:version/timeline` — the compiled timeline of one version, loaded lazily by
 * the Preview (animatic) and Timeline JSON tabs instead of being serialized into the page. Proxies the Studio API
 * server-side (token never in the browser); the body was validated with `ProjectVersionDTOSchema` (→
 * `TimelineSchema`) and the client validates it again with `TimelineSchema`.
 */
export const dynamic = 'force-dynamic';

type Params = { projectId: string; version: string };

export async function GET(_request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { projectId, version: rawVersion } = await context.params;
  const version = parseVersionParam(rawVersion);
  if (!isValidId(projectId) || version === null) return jsonError(400, 'VALIDATION_ERROR', 'Invalid project or version.');
  try {
    const projectVersion = await getProjectVersion(projectId, version);
    return jsonOk(projectVersion.timeline);
  } catch (error) {
    return errorResponse(error, 'GET /api/projects/:id/versions/:version/timeline');
  }
}
