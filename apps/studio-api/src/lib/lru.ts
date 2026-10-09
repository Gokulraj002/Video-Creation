/**
 * Least-recently-used string cache bounded by total size (UTF-16 code units ≈ bytes for JSON text).
 * Entries larger than the whole budget are not cached. A budget of 0 disables the cache.
 */
export class SizeBoundedLru {
  private readonly entries = new Map<string, string>();
  private size = 0;

  constructor(readonly maxSize: number) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    this.delete(key);
    if (value.length > this.maxSize) return;
    this.entries.set(key, value);
    this.size += value.length;
    while (this.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const value = this.entries.get(key);
    if (value === undefined) return;
    this.entries.delete(key);
    this.size -= value.length;
  }

  get totalSize(): number {
    return this.size;
  }

  get count(): number {
    return this.entries.size;
  }
}
