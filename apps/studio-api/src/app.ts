import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config';
import type { AppContext } from './context';
import type { PrismaClient } from './db';
import { createDirectorFactory, type DirectorFactory } from './director/factory';
import { AppError } from './lib/errors';
import { hashToken, parseBearerToken } from './lib/tokens';
import { authDecoratorPlugin, createAuthHook } from './plugins/auth';
import { errorsPlugin } from './plugins/errors';
import type { DirectorQueue } from './queue/types';
import { directorRunRoutes } from './routes/director-runs';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { projectRoutes } from './routes/projects';
import { systemRoutes } from './routes/system';
import { usageRoutes } from './routes/usage';

export interface BuildAppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  queue: DirectorQueue;
  directorFactory?: DirectorFactory;
  /** Fastify/pino logger option; defaults to `{level: LOG_LEVEL}` with secrets redacted. Tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
}

export const BODY_LIMIT_BYTES = 1024 * 1024;

/** Paths pino must never print. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.apiKey',
  '*.ANTHROPIC_API_KEY',
  '*.STUDIO_DEV_API_TOKEN',
  'config.ai.anthropic.apiKey',
];

/** Per-token rate-limit key (hash of the bearer token), falling back to the client IP. */
function rateLimitKey(request: FastifyRequest): string {
  const token = parseBearerToken(request.headers.authorization);
  return token === null ? `ip:${request.ip}` : `tok:${hashToken(token)}`;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { config, prisma, queue } = deps;
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: deps.logger ?? { level: config.logLevel, redact: { paths: LOG_REDACT_PATHS, censor: '[Redacted]' } },
  });
  const directorFactory = deps.directorFactory ?? createDirectorFactory(config);
  const ctx: AppContext = { config, prisma, queue, directorFactory, logger: app.log };

  // JSON bodies: Fastify's secure default parser, but an empty body reads as `undefined`
  // (lets clients POST to action endpoints such as /cancel with a JSON content type and no body).
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJsonParser(request, text, done);
  });

  await app.register(errorsPlugin);
  await app.register(authDecoratorPlugin);
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: 60_000,
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (_request, context) =>
      new AppError(context.statusCode, 'RATE_LIMITED', `Rate limit exceeded, retry in ${context.after}`),
  });

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      v1.addHook('onRequest', createAuthHook(prisma));
      await v1.register(meRoutes);
      await v1.register(systemRoutes, ctx);
      await v1.register(projectRoutes, ctx);
      await v1.register(directorRunRoutes, ctx);
      await v1.register(usageRoutes, ctx);
    },
    { prefix: '/v1' },
  );

  return app;
}
