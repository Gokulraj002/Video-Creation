import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from './config';
import type { AppContext } from './context';
import type { PrismaClient } from './db';
import { createDirectorFactory, type DirectorFactory } from './director/factory';
import { AppError, rateLimited } from './lib/errors';
import { SizeBoundedLru } from './lib/lru';
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

const RATE_WINDOW_MS = 60_000;

type LimiterState = Awaited<ReturnType<ReturnType<FastifyInstance['createRateLimit']>>>;

function setRateHeaders(reply: FastifyReply, state: Extract<LimiterState, { isAllowed: false }>): void {
  reply.header('x-ratelimit-limit', state.max);
  reply.header('x-ratelimit-remaining', state.remaining);
  reply.header('x-ratelimit-reset', state.ttlInSeconds);
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { config, prisma, queue } = deps;
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: deps.logger ?? { level: config.logLevel, redact: { paths: LOG_REDACT_PATHS, censor: '[Redacted]' } },
  });
  const directorFactory = deps.directorFactory ?? createDirectorFactory(config);
  const versionCache = config.versionCacheMaxBytes > 0 ? new SizeBoundedLru(config.versionCacheMaxBytes) : null;
  const ctx: AppContext = { config, prisma, queue, directorFactory, logger: app.log, versionCache };

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
  // Limiters are applied explicitly as /v1 hooks (not per route), so their order relative to auth is fixed.
  await app.register(rateLimit, {
    global: false,
    timeWindow: RATE_WINDOW_MS,
    errorResponseBuilder: (_request, context) =>
      new AppError(context.statusCode, 'RATE_LIMITED', `Rate limit exceeded, retry in ${context.after}`),
  });
  // Failed authentications per client IP (IPv6 grouped per /64). Checked BEFORE auth without counting, so a
  // client over its budget is refused without a token lookup; incremented on every 401.
  const authFailures = app.createRateLimit({ max: config.rateLimitUnauthPerMinute, timeWindow: RATE_WINDOW_MS });
  // Requests per authenticated user (all of the user's tokens share it), checked AFTER auth.
  const perUser = app.createRateLimit({
    max: config.rateLimitPerMinute,
    timeWindow: RATE_WINDOW_MS,
    keyGenerator: (request) => `user:${request.user?.id ?? ''}`,
  });

  const guardFailedAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const state = await authFailures(request, { increment: false });
    if (state.isAllowed || state.remaining > 0) return;
    setRateHeaders(reply, state);
    reply.header('retry-after', state.ttlInSeconds);
    throw rateLimited(state.ttlInSeconds);
  };
  const countFailedAuth = async (request: FastifyRequest): Promise<void> => {
    await authFailures(request);
  };
  const limitUser = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const state = await perUser(request);
    if (state.isAllowed) return;
    setRateHeaders(reply, state);
    if (!state.isExceeded) return;
    reply.header('retry-after', state.ttlInSeconds);
    throw rateLimited(state.ttlInSeconds);
  };

  await app.register(healthRoutes, { prisma, queue });
  await app.register(
    async (v1) => {
      // Order matters: per-IP failed-auth guard → authentication (counts failures) → per-user limit.
      v1.addHook('onRequest', guardFailedAuth);
      v1.addHook('onRequest', createAuthHook(prisma, { onFailure: countFailedAuth }));
      v1.addHook('onRequest', limitUser);
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
