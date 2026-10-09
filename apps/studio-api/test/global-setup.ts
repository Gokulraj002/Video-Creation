import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Applies the committed migrations to the test database once per `vitest run`. */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_studio_test';
  if (!/video_studio_test/.test(url)) {
    throw new Error(`Refusing to run tests against a non-test database (${url.replace(/\/\/[^@]*@/, '//***@')})`);
  }
  execFileSync(resolve(appRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: appRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
