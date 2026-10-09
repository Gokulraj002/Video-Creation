import type { FastifyInstance } from 'fastify';
import type { UsageSummaryDTO } from '@vc/schema';
import type { AppContext } from '../context';
import { requireUser } from '../plugins/auth';
import { usageSummary } from '../services/usage';

export async function usageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/usage', async (request): Promise<UsageSummaryDTO> => usageSummary(ctx.prisma, requireUser(request).id));
}
