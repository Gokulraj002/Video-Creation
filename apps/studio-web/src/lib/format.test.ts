import { describe, expect, it } from 'vitest';
import {
  formatCompactNumber,
  formatDateTime,
  formatLatency,
  formatNumber,
  formatRelativeTime,
  formatUsd,
  humanizeSlug,
  truncate,
} from './format';

describe('number formatting', () => {
  it('formats integers with grouping', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(Number.NaN)).toBe('—');
  });

  it('switches to compact notation for large values', () => {
    expect(formatCompactNumber(9999)).toBe('9,999');
    expect(formatCompactNumber(12_345)).toBe('12.3K');
    expect(formatCompactNumber(2_500_000)).toBe('2.5M');
  });

  it('formats USD with adaptive precision', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('formats latency', () => {
    expect(formatLatency(250)).toBe('250 ms');
    expect(formatLatency(1530)).toBe('1.53 s');
    expect(formatLatency(12_340)).toBe('12.3 s');
  });
});

describe('dates', () => {
  it('formats absolute times in UTC', () => {
    expect(formatDateTime('2026-10-09T08:25:00.000Z')).toBe('Oct 9, 2026, 08:25 UTC');
    expect(formatDateTime('not a date')).toBe('—');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');
    expect(formatRelativeTime('2026-10-09T11:59:50.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-10-09T11:55:00.000Z', now)).toBe('5 min ago');
    expect(formatRelativeTime('2026-10-09T09:00:00.000Z', now)).toBe('3 h ago');
    expect(formatRelativeTime('2026-10-07T12:00:00.000Z', now)).toBe('2 days ago');
    expect(formatRelativeTime('2026-01-01T00:00:00.000Z', now)).toBe('Jan 1, 2026, 00:00 UTC');
  });
});

describe('text helpers', () => {
  it('humanizes slugs with acronyms', () => {
    expect(humanizeSlug('sop-training')).toBe('SOP training');
    expect(humanizeSlug('close-up')).toBe('Close up');
    expect(humanizeSlug('product-3d')).toBe('Product 3D');
  });

  it('truncates on word boundaries', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('the quick brown fox jumps', 18)).toBe('the quick brown…');
    expect(truncate('abcdefghijklmnop', 6)).toBe('abcde…');
  });
});
