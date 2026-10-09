import { createHash } from 'node:crypto';
import type { CacheEntry, CacheLookupContext, DirectorCache } from '@vc/ai-director';
import { DirectorStageSchema, TokenUsageSchema } from '@vc/schema';
import type { PrismaClient } from '../db';
import { toJsonInput } from '../lib/json';

/**
 * Postgres-backed AI Director cache (`director_cache_entries`), scoped to one owner: the stored key is
 * `sha256(scope + "\n" + directorKey)`, so one user's runs can never hit (and thereby reveal) another user's
 * prompts. The director only stores VALIDATED stage outputs; a hit bumps `hits` / `lastHitAt`.
 * Corrupt rows read as a miss.
 */
export class PrismaDirectorCache implements DirectorCache {
  constructor(
    private readonly prisma: PrismaClient,
    /** Owner scope, e.g. the requesting user's id. */
    private readonly scope: string,
  ) {
    if (scope.length === 0) throw new Error('PrismaDirectorCache requires a non-empty scope');
  }

  /** The database key for a director cache key within this scope. */
  storageKey(key: string): string {
    return createHash('sha256').update(`${this.scope}\n${key}`, 'utf8').digest('hex');
  }

  async get(key: string, _context?: CacheLookupContext): Promise<CacheEntry | null> {
    const storageKey = this.storageKey(key);
    const row = await this.prisma.directorCacheEntry.findUnique({ where: { key: storageKey } });
    if (row === null) return null;
    const usage = TokenUsageSchema.safeParse(row.usage);
    const stage = DirectorStageSchema.safeParse(row.stage);
    if (!usage.success || !stage.success) return null;
    await this.prisma.directorCacheEntry.updateMany({
      where: { key: storageKey },
      data: { hits: { increment: 1 }, lastHitAt: new Date() },
    });
    return {
      stage: stage.data,
      chunk: row.chunk,
      output: row.output,
      usage: usage.data,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const storageKey = this.storageKey(key);
    const data = {
      stage: entry.stage,
      chunk: entry.chunk,
      model: entry.model,
      provider: entry.provider,
      output: toJsonInput(entry.output),
      usage: toJsonInput(entry.usage),
    };
    await this.prisma.directorCacheEntry.upsert({
      where: { key: storageKey },
      create: { key: storageKey, ...data },
      update: data,
    });
  }
}
