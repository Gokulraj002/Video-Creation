import type { DirectorStage, TokenUsage } from '@vc/schema';
import { canonicalJson, sha256Hex } from './util/json';

export interface CacheEntry {
  /** Stage / chunk that produced the output (lets persistent caches index and report entries). */
  stage: DirectorStage;
  chunk: string | null;
  /** A VALIDATED stage output. */
  output: unknown;
  usage: TokenUsage;
  provider: string;
  model: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** Stage context passed alongside every cache lookup (optional for implementations to use). */
export interface CacheLookupContext {
  stage: DirectorStage;
  chunk: string | null;
}

export interface DirectorCache {
  get(key: string, context?: CacheLookupContext): Promise<CacheEntry | null>;
  /** `entry.stage` / `entry.chunk` identify the producing stage. */
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
  /**
   * `hashStageInput(input)`: the structured stage input. Mock providers build outputs from it and the rendered prompt
   * does not carry every field, so it must be part of the key. The director always sets it.
   */
  inputHash?: string | null;
  /** `AIProvider.configFingerprint` (effort, structured-output mode, fallbacks, mock version...). */
  providerFingerprint?: string | null;
}

/** sha256 hex of the canonical (sorted-key) JSON of a structured stage input. */
export function hashStageInput(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

/**
 * sha256 hex of the canonical (sorted-key) JSON of the parts. Optional parts that are omitted (undefined) do not
 * contribute, so keys computed without them are unchanged.
 */
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
      inputHash: parts.inputHash ?? undefined,
      providerFingerprint: parts.providerFingerprint ?? undefined,
    }),
  );
}
