import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { PrismaClient } from '../db';
import { unauthorized } from '../lib/errors';
import { hashToken, parseBearerToken } from '../lib/tokens';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every `/v1/*` request; null on public routes. */
    user: AuthUser | null;
  }
}

/** `lastUsedAt` is refreshed at most once per minute per token to keep auth cheap. */
const LAST_USED_REFRESH_MS = 60_000;

/** Decorates `request.user` (null by default). Registered once at the root. */
export const authDecoratorPlugin = fp(
  async (app: FastifyInstance) => {
    app.decorateRequest('user', null);
  },
  { name: 'studio-auth-decorator' },
);

/**
 * Builds the `onRequest` hook that authenticates `Authorization: Bearer <token>` against hashed
 * `ApiToken` rows (revoked tokens are rejected). Register it inside the `/v1` scope.
 */
export function createAuthHook(prisma: PrismaClient) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const raw = parseBearerToken(request.headers.authorization);
    if (raw === null) throw unauthorized();
    const token = await prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: {
        id: true,
        revokedAt: true,
        lastUsedAt: true,
        user: { select: { id: true, email: true, name: true } },
      },
    });
    if (token === null || token.revokedAt !== null) throw unauthorized();
    const now = Date.now();
    if (token.lastUsedAt === null || now - token.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
      await prisma.apiToken.updateMany({ where: { id: token.id }, data: { lastUsedAt: new Date(now) } });
    }
    request.user = { id: token.user.id, email: token.user.email, name: token.user.name, tokenId: token.id };
  };
}

/** Returns the authenticated user or throws 401 (for handlers inside the `/v1` scope). */
export function requireUser(request: FastifyRequest): AuthUser {
  if (request.user === null) throw unauthorized();
  return request.user;
}
