import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateProjectRequestSchema,
  DbIdSchema,
  type ProjectDetailDTO,
  type ProjectSummaryPage,
  type ProjectVersionDTO,
  type ProjectVersionSummaryDTO,
} from '@vc/schema';
import type { AppContext } from '../context';
import { requireUser } from '../plugins/auth';
import {
  createProject,
  deleteProject,
  getProjectDetail,
  getVersion,
  listProjects,
  listVersions,
} from '../services/projects';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .max(128)
    .optional()
    .transform((c) => (c === undefined || c === '' ? null : c)),
});

export const ProjectParamsSchema = z.object({ id: DbIdSchema });
const VersionParamsSchema = z.object({
  id: DbIdSchema,
  version: z.coerce.number().int().min(1).max(2_147_483_647),
});

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/projects', async (request): Promise<ProjectSummaryPage> => {
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

  app.get('/projects/:id/versions/:version', async (request): Promise<ProjectVersionDTO> => {
    const user = requireUser(request);
    const { id, version } = VersionParamsSchema.parse(request.params);
    return getVersion(ctx.prisma, user.id, id, version);
  });
}
