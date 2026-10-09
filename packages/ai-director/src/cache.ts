import type { DirectorStage, TokenUsage } from '@vc/schema';
import { canonicalJson, sha256Hex } from './util/json';

export interface CacheEntry {
  /** A VALIDATED stage output. */
  output: unknown;
  usage: TokenUsage;
  provider: string;
  model: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface DirectorCache {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/** In-memory LRU cache (Map insertion order = recency). */
export class MemoryDirectorCache implements DirectorCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 500) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
  }

  get size(): number {
    return this.entries.size;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface CacheKeyParts {
  stage: DirectorStage;
  chunk: string | null;
  promptVersion: string;
  provider: string;
  model: string;
  schemaName: string;
  system: string;
  prompt: string;
}

/** sha256 hex of the canonical (sorted-key) JSON of the parts. */
export function computeCacheKey(parts: CacheKeyParts): string {
  return sha256Hex(
    canonicalJson({
      stage: parts.stage,
      chunk: parts.chunk,
      promptVersion: parts.promptVersion,
      provider: parts.provider,
      model: parts.model,
      schemaName: parts.schemaName,
      system: parts.system,
      prompt: parts.prompt,
    }),
  );
}
