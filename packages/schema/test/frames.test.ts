import { describe, expect, it } from 'vitest';
import { allocateFrames, formatTimecode, framesToSeconds, secondsToFrames } from '../src/index';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('secondsToFrames / framesToSeconds', () => {
  it('rounds seconds × fps', () => {
    expect(secondsToFrames(1, 30)).toBe(30);
    expect(secondsToFrames(2.5, 24)).toBe(60);
    expect(secondsToFrames(0.0166, 60)).toBe(1);
    expect(secondsToFrames(1.49 / 30, 30)).toBe(1);
    expect(secondsToFrames(7200, 60)).toBe(432_000);
  });
  it('converts frames back to seconds', () => {
    expect(framesToSeconds(90, 30)).toBe(3);
    expect(framesToSeconds(1, 4)).toBe(0.25);
    expect(() => framesToSeconds(1, 0)).toThrow(RangeError);
  });
});

describe('allocateFrames', () => {
  it('sums exactly to totalFrames and is proportional', () => {
    expect(allocateFrames([1, 1, 1], 9)).toEqual([3, 3, 3]);
    expect(allocateFrames([1, 2, 3], 60)).toEqual([10, 20, 30]);
    expect(allocateFrames([1], 123)).toEqual([123]);
    expect(allocateFrames([0.5, 0.25, 0.25], 4)).toEqual([2, 1, 1]);
  });

  it('uses largest remainders', () => {
    // quotas 3.5, 2.8, 3.7 → floors 3,2,3 (8); 2 leftover go to the largest remainders .8 (index 1) and .7 (index 2)
    expect(allocateFrames([3.5, 2.8, 3.7], 10)).toEqual([3, 3, 4]);
    // quotas 1.6, 1.6, 6.8 → floors 1,1,6 (8); remainders .6,.6,.8 → index 2, then index 0
    expect(allocateFrames([1.6, 1.6, 6.8], 10)).toEqual([2, 1, 7]);
  });

  it('breaks ties by lower index first (deterministic)', () => {
    expect(allocateFrames([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(allocateFrames([1, 1, 1], 11)).toEqual([4, 4, 3]);
    expect(allocateFrames([1, 1, 1, 1], 6)).toEqual([2, 2, 1, 1]);
    expect(allocateFrames([2, 1, 1], 5)).toEqual([3, 1, 1]);
    for (let i = 0; i < 5; i++) expect(allocateFrames([1, 1, 1], 10)).toEqual([4, 3, 3]);
  });

  it('respects minFrames by pinning small weights and re-apportioning the rest', () => {
    const out = allocateFrames([1, 1000], 100, 30);
    expect(out).toEqual([30, 70]);
    const out2 = allocateFrames([0.001, 0.001, 10], 90, 30);
    expect(out2).toEqual([30, 30, 30]);
    const out3 = allocateFrames([1, 100, 100], 31, 5);
    expect(out3.every((v) => v >= 5)).toBe(true);
    expect(sum(out3)).toBe(31);
    expect(out3[0]).toBe(5);
  });

  it('allows minFrames = 0 and default minFrames = 1', () => {
    expect(allocateFrames([1, 1000], 10, 0)).toEqual([0, 10]);
    expect(allocateFrames([1, 1000], 10)).toEqual([1, 9]);
  });

  it('holds sum/min invariants for many random inputs (seeded)', () => {
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const weights = Array.from({ length: n }, () => 0.01 + rand() * 20);
      const minFrames = Math.floor(rand() * 40);
      const totalFrames = n * minFrames + Math.floor(rand() * 5000);
      const out = allocateFrames(weights, totalFrames, minFrames);
      expect(out).toHaveLength(n);
      expect(sum(out)).toBe(totalFrames);
      expect(out.every((v) => Number.isInteger(v) && v >= minFrames)).toBe(true);
      expect(allocateFrames(weights, totalFrames, minFrames)).toEqual(out);
    }
  });

  it('handles very long timelines exactly', () => {
    const weights = Array.from({ length: 2000 }, (_, i) => 1 + (i % 7));
    const total = 7200 * 60; // 2 h at 60 fps
    const out = allocateFrames(weights, total, 60);
    expect(sum(out)).toBe(total);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(60);
  });

  it('allows exactly n × minFrames', () => {
    expect(allocateFrames([1, 5, 9], 90, 30)).toEqual([30, 30, 30]);
  });

  it('throws RangeError when weights.length × minFrames > totalFrames', () => {
    expect(() => allocateFrames([1, 1, 1], 89, 30)).toThrow(RangeError);
    expect(() => allocateFrames([1, 1], 1)).toThrow(RangeError);
  });

  it('throws RangeError for invalid weights or totals', () => {
    expect(() => allocateFrames([], 10)).toThrow(RangeError);
    expect(() => allocateFrames([1, 0], 10)).toThrow(RangeError);
    expect(() => allocateFrames([1, -1], 10)).toThrow(RangeError);
    expect(() => allocateFrames([1, Number.NaN], 10)).toThrow(RangeError);
    expect(() => allocateFrames([1, Number.POSITIVE_INFINITY], 10)).toThrow(RangeError);
    expect(() => allocateFrames([1], 10.5)).toThrow(RangeError);
    expect(() => allocateFrames([1], -1)).toThrow(RangeError);
    expect(() => allocateFrames([1], 10, -1)).toThrow(RangeError);
    expect(() => allocateFrames([1], 10, 1.5)).toThrow(RangeError);
  });
});

describe('formatTimecode', () => {
  it('formats HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(29, 30)).toBe('00:00:00:29');
    expect(formatTimecode(30, 30)).toBe('00:00:01:00');
    expect(formatTimecode(30 * 61 + 5, 30)).toBe('00:01:01:05');
    expect(formatTimecode(30 * 3600, 30)).toBe('01:00:00:00');
    expect(formatTimecode(24 * 7322 + 23, 24)).toBe('02:02:02:23');
    expect(formatTimecode(60 * 3600 * 25, 60)).toBe('25:00:00:00');
  });
  it('uses the rounded fps as the frame base', () => {
    expect(formatTimecode(30, 29.97)).toBe('00:00:01:00');
  });
  it('rejects invalid input', () => {
    expect(() => formatTimecode(-1, 30)).toThrow(RangeError);
    expect(() => formatTimecode(0, 0)).toThrow(RangeError);
    expect(() => formatTimecode(Number.NaN, 30)).toThrow(RangeError);
  });
});
