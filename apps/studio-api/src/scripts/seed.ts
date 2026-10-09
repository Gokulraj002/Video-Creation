import { ConfigError, loadConfig } from '../config';
import { createPrisma, type PrismaClient } from '../db';
import { hashToken } from '../lib/tokens';

export interface SeedResult {
  userId: string;
  tokenId: string;
  /** Problems that need an operator decision (the seed never re-activates or re-assigns a token). */
  warnings: string[];
}

/**
 * Upserts the development user and its API token (stored as a sha256 hash only).
 * Idempotent: re-running with the same token keeps one row; a new token value adds a new row.
 * An existing token row is never modified: a revoked token stays revoked and a token that belongs to another
 * user stays with that user (both are reported as warnings; use a new STUDIO_DEV_API_TOKEN instead).
 */
export async function seedDevUser(prisma: PrismaClient, email: string, rawToken: string): Promise<SeedResult> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name: 'Studio Developer' },
    update: {},
    select: { id: true },
  });
  const token = await prisma.apiToken.upsert({
    where: { tokenHash: hashToken(rawToken) },
    create: { userId: user.id, label: 'dev seed token', tokenHash: hashToken(rawToken) },
    update: {},
    select: { id: true, userId: true, revokedAt: true },
  });
  const warnings: string[] = [];
  if (token.revokedAt !== null) {
    warnings.push(
      `API token ${token.id} was revoked at ${token.revokedAt.toISOString()} and stays revoked; ` +
        'set a new STUDIO_DEV_API_TOKEN value to seed a working token.',
    );
  }
  if (token.userId !== user.id) {
    warnings.push(
      `API token ${token.id} belongs to another user and was not reassigned to ${email}; ` +
        'set a new STUDIO_DEV_API_TOKEN value for this user.',
    );
  }
  return { userId: user.id, tokenId: token.id, warnings };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const rawToken = config.dev.apiToken;
  if (rawToken === undefined) {
    throw new ConfigError(['STUDIO_DEV_API_TOKEN: required by the seed script (at least 32 characters)']);
  }
  const prisma = createPrisma(config.databaseUrl, { max: 2, connectionTimeoutMs: config.databasePool.connectionTimeoutMs });
  try {
    const result = await seedDevUser(prisma, config.dev.userEmail, rawToken);
    for (const warning of result.warnings) process.stderr.write(`WARNING: ${warning}\n`);
    // Never print the token itself.
    process.stdout.write(
      `Seeded dev user ${config.dev.userEmail} (id ${result.userId}) with API token id ${result.tokenId}.\n` +
        'Use the STUDIO_DEV_API_TOKEN value as the bearer token (e.g. STUDIO_API_TOKEN for studio-web).\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isEntrypoint = process.argv[1] !== undefined && /seed\.[cm]?[jt]s$/.test(process.argv[1]);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
