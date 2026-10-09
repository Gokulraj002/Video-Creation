import { errorResponse, isValidId, jsonError, jsonOk, parseVersionParam } from '@/lib/route-response';
import { STORYBOARD_MAX_PAGE_SIZE, STORYBOARD_PAGE_SIZE, pageChapterRows, storyboardFor } from '@/lib/storyboard';
import { getProjectVersion } from '@/lib/studio-api';

/**
 * `GET /api/projects/:projectId/versions/:version/storyboard?chapter=<id>&offset=0&limit=60` — one page of a
 * chapter's storyboard cards (`StoryboardPage`). The project page renders chapter headers plus a small initial set of
 * cards; expanding a chapter (or "Show more") loads the rest from here, so multi-hour storyboards never ship
 * thousands of cards up front. Server-side proxy: the token never reaches the browser.
 */
export const dynamic = 'force-dynamic';

type Params = { projectId: string; version: string };

function intParam(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,7}$/.test(raw)) return null;
  return Math.min(Number(raw), max);
}

export async function GET(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { projectId, version: rawVersion } = await context.params;
  const version = parseVersionParam(rawVersion);
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapter') ?? '';
  const offset = intParam(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url.searchParams.get('limit'), STORYBOARD_PAGE_SIZE, STORYBOARD_MAX_PAGE_SIZE);
  if (!isValidId(projectId) || version === null || chapterId === '' || chapterId.length > 128 || offset === null || limit === null || limit < 1) {
    return jsonError(400, 'VALIDATION_ERROR', 'Invalid storyboard request.');
  }
  try {
    const projectVersion = await getProjectVersion(projectId, version);
    const page = pageChapterRows(storyboardFor(projectVersion), chapterId, offset, limit);
    if (!page) return jsonError(404, 'NOT_FOUND', 'Chapter not found.');
    return jsonOk(page);
  } catch (error) {
    return errorResponse(error, 'GET /api/projects/:id/versions/:version/storyboard');
  }
}
