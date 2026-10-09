import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateDirectorRunRequestSchema, DbIdSchema, type DirectorRunDTO } from '@vc/schema';
import type { AppContext } from '../context';
import { requireUser } from '../plugins/auth';
import { cancelRun, getRun, listProjectRuns, startDirectorRun } from '../services/director-runs';
import { ProjectParamsSchema } from './projects';

const RunParamsSchema = z.object({ runId: DbIdSchema });

export async function directorRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/projects/:id/director-runs', async (request, reply): Promise<DirectorRunDTO> => {
    const user = requireUser(request);
    const { id } = ProjectParamsSchema.parse(request.params);
    // The body is reserved (empty object; unknown keys ignored); a missing body is accepted.
    CreateDirectorRunRequestSchema.parse(request.body ?? {});
    const run = await startDirectorRun(ctx, user.id, id);
    reply.status(202);
    return run;
  });

  app.get('/projects/:id/director-runs', async (request): Promise<DirectorRunDTO[]> => {
    const user = requireUser(request);
    const { id } = ProjectParamsSchema.parse(request.params);
    return listProjectRuns(ctx.prisma, user.id, id);
  });

  app.get('/director-runs/:runId', async (request): Promise<DirectorRunDTO> => {
    const user = requireUser(request);
    const { runId } = RunParamsSchema.parse(request.params);
    return getRun(ctx.prisma, user.id, runId);
  });

  app.post('/director-runs/:runId/cancel', async (request): Promise<DirectorRunDTO> => {
    const user = requireUser(request);
    const { runId } = RunParamsSchema.parse(request.params);
    return cancelRun(ctx.prisma, user.id, runId);
  });
}
