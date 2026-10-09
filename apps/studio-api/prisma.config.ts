import { defineConfig } from 'prisma/config';

// `prisma generate` does not need a reachable database; migrate commands read DATABASE_URL.
const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_studio';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: { url },
});
