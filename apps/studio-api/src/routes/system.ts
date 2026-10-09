import type { FastifyInstance } from 'fastify';
import type { SystemConfigDTO } from '@vc/schema';
import type { AppContext } from '../context';
import { systemConfig } from '../services/system';

export async function systemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/system/config', async (): Promise<SystemConfigDTO> =>
    systemConfig(ctx.config, ctx.directorFactory, ctx.queue.driver),
  );
}
