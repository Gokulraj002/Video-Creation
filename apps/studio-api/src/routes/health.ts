import type { FastifyInstance } from 'fastify';
import { STUDIO_API_VERSION } from '../version';

/** Public liveness probe (not rate limited, no auth). */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true as const, version: STUDIO_API_VERSION }));
}
