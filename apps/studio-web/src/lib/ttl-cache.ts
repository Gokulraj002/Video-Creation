/**
 * Tiny bounded LRU map with a per-entry time-to-live. Pure (the clock is injectable for tests).
 * Reading an entry refreshes its LRU position but not its expiry.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries: number; ttlMs: number; now?: () => number }) {
    this.maxEntries = Math.max(1, Math.trunc(opts.maxEntries));
    this.ttlMs = Math.max(0, opts.ttlMs);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Live value (refreshing its recency), or `undefined` when missing / expired. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Live value without touching recency. */
  peek(key: K): V | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > this.now() ? entry.value : undefined;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  deleteWhere(predicate: (key: K) => boolean): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (predicate(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }
}
