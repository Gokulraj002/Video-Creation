import type { CacheEntry, DirectorCache } from '@vc/ai-director';
import { TokenUsageSchema } from '@vc/schema';
import type { PrismaClient } from '../db';
import { toJsonInput } from '../lib/json';

/**
 * Postgres-backed AI Director cache (`director_cache_entries`). The director only stores VALIDATED
 * stage outputs; a hit bumps `hits` / `lastHitAt`. Corrupt rows read as a miss.
 */
export class PrismaDirectorCache implements DirectorCache {
  constructor(private readonly prisma: PrismaClient) {}

  async get(key: string): Promise<CacheEntry | null> {
    const row = await this.prisma.directorCacheEntry.findUnique({ where: { key } });
    if (row === null) return null;
    const usage = TokenUsageSchema.safeParse(row.usage);
    if (!usage.success) return null;
    await this.prisma.directorCacheEntry.updateMany({
      where: { key },
      data: { hits: { increment: 1 }, lastHitAt: new Date() },
    });
    return {
      output: row.output,
      usage: usage.data,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const data = {
      stage: stageOf(entry),
      model: entry.model,
      provider: entry.provider,
      output: toJsonInput(entry.output),
      usage: toJsonInput(entry.usage),
    };
    await this.prisma.directorCacheEntry.upsert({
      where: { key },
      create: { key, ...data },
      update: data,
    });
  }
}

/** `CacheEntry` does not carry the stage in the M1 contract; record it when an implementation provides one. */
function stageOf(entry: CacheEntry): string {
  const candidate: unknown = (entry as { stage?: unknown }).stage;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown';
}
