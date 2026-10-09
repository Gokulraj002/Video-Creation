import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateProjectRequestSchema,
  CURRENT_TIMELINE_VERSION,
  DbIdSchema,
  type ProjectDetailDTO,
  type ProjectVersionSummaryDTO,
} from '@vc/schema';
import type { AppContext } from '../context';
import { requireUser } from '../plugins/auth';
import {
  createProject,
  deleteProject,
  findVersionId,
  getProjectDetail,
  listProjects,
  listVersions,
  versionDtoJson,
  type ProjectSummaryPageWithTotal,
} from '../services/projects';
import { STUDIO_API_VERSION } from '../version';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .max(128)
    .optional()
    .transform((c) => (c === undefined || c === '' ? null : c)),
});

export const ProjectParamsSchema = z.object({ id: DbIdSchema });

/** Versions never change: private (per-user) caching for a year. */
export const VERSION_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** Strong ETag of a version's JSON: its id plus everything that can change the serialized DTO. */
export function versionEtag(versionId: string): string {
  return `"pv-${versionId}-t${CURRENT_TIMELINE_VERSION}-${STUDIO_API_VERSION}"`;
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}
const VersionParamsSchema = z.object({
  id: DbIdSchema,
  version: z.coerce.number().int().min(1).max(2_147_483_647),
});

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/projects', async (request): Promise<ProjectSummaryPageWithTotal> => {
    const user = requireUser(request);
    const query = ListQuerySchema.parse(request.query);
    return listProjects(ctx.prisma, user.id, query);
  });

  app.post('/projects', async (request, reply): Promise<ProjectDetailDTO> => {
    const user = requireUser(request);
    const body = CreateProjectRequestSchema.parse(request.body);
    const project = await createProject(ctx.prisma, user.id, body, ctx.config.limits);
    reply.status(201);
    return project;
  });

  app.get('/projects/:id', async (request): Promise<ProjectDetailDTO> => {
    const user = requireUser(request);
    const { id } = ProjectParamsSchema.parse(request.params);
    return getProjectDetail(ctx.prisma, user.id, id);
  });

  app.delete('/projects/:id', async (request, reply) => {
    const user = requireUser(request);
    const { id } = ProjectParamsSchema.parse(request.params);
    await deleteProject(ctx.prisma, user.id, id);
    return reply.status(204).send();
  });

  app.get('/projects/:id/versions', async (request): Promise<ProjectVersionSummaryDTO[]> => {
    const user = requireUser(request);
    const { id } = ProjectParamsSchema.parse(request.params);
    return listVersions(ctx.prisma, user.id, id);
  });

  // Returns the serialized ProjectVersionDTO (cached per version); 304 for a matching If-None-Match.
  app.get('/projects/:id/versions/:version', async (request, reply) => {
    const user = requireUser(request);
    const { id, version } = VersionParamsSchema.parse(request.params);
    const versionId = await findVersionId(ctx.prisma, user.id, id, version);
    const etag = versionEtag(versionId);
    reply.header('etag', etag).header('cache-control', VERSION_CACHE_CONTROL);
    if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) return reply.status(304).send();
    const body = await versionDtoJson(ctx.prisma, ctx.versionCache, versionId);
    return reply.type('application/json; charset=utf-8').send(body);
  });
}
