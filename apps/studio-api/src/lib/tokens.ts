import { createHash, randomBytes } from 'node:crypto';

/** Prefix that makes studio API tokens easy to recognise (e.g. by secret scanners). */
export const API_TOKEN_PREFIX = 'vcs_';

/** sha256 hex of a raw bearer token. Only this hash is ever stored. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Generates a new random bearer token (`vcs_` + 43 base64url chars = 256 bits of entropy). */
export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header value.
 * Returns null for missing, malformed or absurdly long values.
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length < 16 || token.length > 512) return null;
  return token;
}
