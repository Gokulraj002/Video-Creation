import { describe, expect, it } from 'vitest';
import { TtlCache } from './ttl-cache';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    const c = clock();
    const cache = new TtlCache<string, number>({ maxEntries: 5, ttlMs: 1000, now: c.now });
    cache.set('a', 1);
    c.advance(999);
    expect(cache.get('a')).toBe(1);
    c.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const c = clock();
    const cache = new TtlCache<string, number>({ maxEntries: 2, ttlMs: 10_000, now: c.now });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3);
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('a')).toBe(1);
    expect(cache.peek('c')).toBe(3);
  });

  it('deletes by predicate', () => {
    const cache = new TtlCache<string, number>({ maxEntries: 5, ttlMs: 10_000 });
    cache.set('t:p1:1', 1);
    cache.set('t:p1:2', 2);
    cache.set('t:p2:1', 3);
    expect(cache.deleteWhere((k) => k.includes(':p1:'))).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.peek('t:p2:1')).toBe(3);
  });
});
