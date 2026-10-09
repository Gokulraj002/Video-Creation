import { HeuristicMockProvider } from '@vc/ai-director';
import { CreateProjectRequestSchema, type CreateProjectRequestInput } from '@vc/schema';
import { ConfigError, loadConfig, type AppConfig } from '../config';
import { createPrisma, type PrismaClient } from '../db';
import { createDirectorFactory } from '../director/factory';
import { processDirectorRun } from '../director/process-run';
import { silentLogger, type Logger } from '../lib/logger';
import { InlineDirectorQueue } from '../queue/inline';
import { startDirectorRun } from '../services/director-runs';
import { createProject } from '../services/projects';
import { seedDevUser } from './seed';

/** Sample projects that show the range of the director: short vertical promos, an explainer and a longer training video. */
export const DEMO_PROJECTS: readonly CreateProjectRequestInput[] = [
  {
    title: 'Kerala Backwaters 4N/5D Offer',
    prompt:
      'A 30-second Instagram reel for a Kerala holiday package: 4 nights / 5 days from Rs 18,999 per person. ' +
      'Houseboat stay in Alleppey, Munnar tea gardens, Kochi sightseeing, all transfers included. Book on WhatsApp today.',
    genre: 'promo',
    styleNotes: 'Lush greens, calm water, warm sunset light',
    durationSeconds: 30,
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    language: 'en',
    brand: { name: 'Kerala Escapes', colors: ['#0E7C66', '#F4B400'] },
    voiceOver: { enabled: true, style: 'warm and inviting', gender: 'female' },
    music: { enabled: true, mood: 'relaxed' },
  },
  {
    title: 'Palm Grove Villas Launch',
    prompt:
      'A 40-second real estate promo for Palm Grove Villas, Chennai OMR: 3 BHK villas from Rs 1.2 Cr, private pool, ' +
      'clubhouse, 10 minutes from IT parks. Book a site visit.',
    genre: 'real-estate',
    styleNotes: 'Premium, airy, golden hour',
    durationSeconds: 40,
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    language: 'en',
    brand: { name: 'Palm Grove', colors: ['#1F4E3D', '#D4AF37'] },
    voiceOver: { enabled: true, style: 'confident', gender: 'male' },
    music: { enabled: true, mood: 'elegant' },
  },
  {
    title: 'WhatsApp Automation Explainer',
    prompt:
      'A 60-second explainer for a WhatsApp automation tool for online stores: order confirmations, delivery updates, ' +
      'abandoned-cart reminders and broadcast offers, all sent automatically. Setup takes 10 minutes. Start a free trial.',
    genre: 'explainer',
    styleNotes: 'Clean flat UI, friendly, step by step',
    durationSeconds: 60,
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    language: 'en',
    brand: { name: 'ChatFlow', colors: ['#25D366', '#075E54'] },
    voiceOver: { enabled: true, style: 'clear and upbeat', gender: 'neutral' },
    music: { enabled: true, mood: 'light corporate' },
  },
  {
    title: 'Warehouse Fire Safety SOP',
    prompt:
      'A 3-minute SOP training video for warehouse staff on fire safety: spotting hazards, using a fire extinguisher ' +
      '(pull, aim, squeeze, sweep), raising the alarm, evacuation routes and the assembly point.',
    genre: 'sop-training',
    styleNotes: 'Clear, calm, instructional',
    durationSeconds: 180,
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    language: 'en',
    brand: { name: 'SafeOps', colors: ['#D32F2F', '#263238'] },
    voiceOver: { enabled: true, style: 'calm instructor', gender: 'female' },
    music: { enabled: false },
  },
];

export interface DemoSeedEntry {
  title: string;
  projectId: string;
  runStatus: string;
  errorMessage: string | null;
}

export interface DemoSeedResult {
  created: DemoSeedEntry[];
  /** Titles the owner already had (the seed never touches existing projects). */
  skipped: string[];
}

/**
 * Creates the demo projects for `ownerId` and runs the director on each, exactly like the API and worker do
 * (same services, same validation, a real Timeline v1 version per project). Always uses the heuristic mock
 * provider, whatever AI_PROVIDER says, so seeding never spends Claude credits. Idempotent per title.
 */
export async function seedDemoProjects(
  prisma: PrismaClient,
  config: AppConfig,
  ownerId: string,
  logger: Logger = silentLogger,
): Promise<DemoSeedResult> {
  const directorFactory = createDirectorFactory(config, { provider: new HeuristicMockProvider() });
  const queue = new InlineDirectorQueue();
  queue.setProcessor((job) => processDirectorRun(job.runId, { prisma, config, directorFactory, logger }));
  const result: DemoSeedResult = { created: [], skipped: [] };
  try {
    for (const input of DEMO_PROJECTS) {
      const request = CreateProjectRequestSchema.parse(input);
      const existing = await prisma.project.findFirst({ where: { ownerId, title: request.title }, select: { id: true } });
      if (existing !== null) {
        result.skipped.push(request.title);
        continue;
      }
      const project = await createProject(prisma, ownerId, request, config.limits);
      const run = await startDirectorRun({ prisma, config, queue, directorFactory, logger }, ownerId, project.id);
      // One run at a time: the per-user active-run quota applies to the seed too.
      await queue.onIdle();
      const finished = await prisma.directorRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { status: true, errorMessage: true },
      });
      result.created.push({
        title: request.title,
        projectId: project.id,
        runStatus: finished.status.toLowerCase(),
        errorMessage: finished.errorMessage,
      });
    }
  } finally {
    await queue.close();
  }
  return result;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const rawToken = config.dev.apiToken;
  if (rawToken === undefined) {
    throw new ConfigError(['STUDIO_DEV_API_TOKEN: required by the demo seed script (at least 32 characters)']);
  }
  const prisma = createPrisma(config.databaseUrl, { max: 2, connectionTimeoutMs: config.databasePool.connectionTimeoutMs });
  try {
    const user = await seedDevUser(prisma, config.dev.userEmail, rawToken);
    for (const warning of user.warnings) process.stderr.write(`WARNING: ${warning}\n`);
    const result = await seedDemoProjects(prisma, config, user.userId);
    for (const entry of result.created) {
      const detail = entry.errorMessage === null ? '' : ` (${entry.errorMessage})`;
      process.stdout.write(`  ${entry.runStatus.padEnd(9)} ${entry.title}${detail}\n`);
    }
    for (const title of result.skipped) process.stdout.write(`  skipped   ${title} (already exists)\n`);
    process.stdout.write(
      `Demo projects for ${config.dev.userEmail}: ${result.created.length} created, ${result.skipped.length} skipped ` +
        '(mock provider, no Claude credits used).\n',
    );
    if (result.created.some((e) => e.runStatus !== 'succeeded')) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isEntrypoint = process.argv[1] !== undefined && /seed-demo\.[cm]?[jt]s$/.test(process.argv[1]);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
