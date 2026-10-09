import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env automatically. Load the package's .env (cwd when run through the
// package scripts) without overriding variables that are already set, e.g. DATABASE_URL in CI.
if (existsSync('.env')) process.loadEnvFile('.env');

// `prisma generate` does not need a reachable database; migrate commands read DATABASE_URL.
const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_studio';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: { url },
});
