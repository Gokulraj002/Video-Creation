import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PROJECTS, seedDemoProjects } from '../src/scripts/seed-demo';
import { seedDevUser } from '../src/scripts/seed';
import { disconnectTestPrisma, testConfig, testPrisma, truncateAll } from './helpers';

const prisma = testPrisma();

beforeEach(async () => {
  await truncateAll(prisma);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe('seedDemoProjects', () => {
  it('creates every demo project with a succeeded run and a timeline version, idempotently', async () => {
    const { userId } = await seedDevUser(prisma, 'dev@localhost', 'dev-token-for-tests-0123456789abcdef-XYZ');
    const first = await seedDemoProjects(prisma, testConfig(), userId);
    expect(first.skipped).toEqual([]);
    expect(first.created.map((e) => e.title)).toEqual(DEMO_PROJECTS.map((p) => p.title));
    expect(first.created.every((e) => e.runStatus === 'succeeded' && e.errorMessage === null)).toBe(true);

    const projects = await prisma.project.findMany({ where: { ownerId: userId }, include: { versions: true } });
    expect(projects).toHaveLength(DEMO_PROJECTS.length);
    for (const project of projects) {
      expect(project.status).toBe('READY');
      expect(project.versions).toHaveLength(1);
    }

    const second = await seedDemoProjects(prisma, testConfig(), userId);
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(DEMO_PROJECTS.length);
    expect(await prisma.project.count({ where: { ownerId: userId } })).toBe(DEMO_PROJECTS.length);
  });

  it('always uses the mock provider, even when AI_PROVIDER=anthropic', async () => {
    const { userId } = await seedDevUser(prisma, 'dev@localhost', 'dev-token-for-tests-0123456789abcdef-XYZ');
    const config = testConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const result = await seedDemoProjects(prisma, config, userId);
    expect(result.created.every((e) => e.runStatus === 'succeeded')).toBe(true);
    const runs = await prisma.directorRun.findMany({ select: { provider: true, estimatedCostUsd: true } });
    expect(runs).toHaveLength(DEMO_PROJECTS.length);
    for (const run of runs) {
      expect(run.provider).toBe('mock');
      expect(run.estimatedCostUsd.toNumber()).toBe(0);
    }
  });
});
