import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatDurationLong,
  formatElapsed,
  formatFrameDuration,
  isDurationUnit,
  parseDurationInput,
  splitDuration,
  toSeconds,
} from './duration';

describe('toSeconds', () => {
  it('converts each unit', () => {
    expect(toSeconds(45, 's')).toBe(45);
    expect(toSeconds(20, 'min')).toBe(1200);
    expect(toSeconds(2, 'h')).toBe(7200);
  });

  it('avoids floating point noise', () => {
    expect(toSeconds(0.1, 'h')).toBe(360);
    expect(toSeconds(1.5, 'min')).toBe(90);
  });

  it('has no hardcoded maximum', () => {
    expect(toSeconds(48, 'h')).toBe(172_800);
  });
});

describe('parseDurationInput', () => {
  it('parses integers, decimals and decimal commas', () => {
    expect(parseDurationInput('30', 's')).toEqual({ ok: true, seconds: 30 });
    expect(parseDurationInput(' 1.5 ', 'min')).toEqual({ ok: true, seconds: 90 });
    expect(parseDurationInput('2,5', 'h')).toEqual({ ok: true, seconds: 9000 });
    expect(parseDurationInput('.5', 's')).toEqual({ ok: true, seconds: 0.5 });
  });

  it('defaults the unit to seconds', () => {
    expect(parseDurationInput('12', undefined)).toEqual({ ok: true, seconds: 12 });
  });

  it('rejects empty, negative, zero and non-numeric input', () => {
    expect(parseDurationInput('', 's').ok).toBe(false);
    expect(parseDurationInput('-5', 's').ok).toBe(false);
    expect(parseDurationInput('0', 'min').ok).toBe(false);
    expect(parseDurationInput('abc', 's').ok).toBe(false);
    expect(parseDurationInput('1e3', 's').ok).toBe(false);
    expect(parseDurationInput('Infinity', 's').ok).toBe(false);
  });

  it('rejects unknown units', () => {
    const result = parseDurationInput('5', 'days');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unit/);
  });
});

describe('isDurationUnit', () => {
  it('narrows known units only', () => {
    expect(isDurationUnit('s')).toBe(true);
    expect(isDurationUnit('min')).toBe(true);
    expect(isDurationUnit('h')).toBe(true);
    expect(isDurationUnit('m')).toBe(false);
    expect(isDurationUnit(5)).toBe(false);
  });
});

describe('splitDuration', () => {
  it('picks the largest whole unit', () => {
    expect(splitDuration(7200)).toEqual({ value: 2, unit: 'h' });
    expect(splitDuration(1200)).toEqual({ value: 20, unit: 'min' });
    expect(splitDuration(5400)).toEqual({ value: 90, unit: 'min' });
    expect(splitDuration(45)).toEqual({ value: 45, unit: 's' });
    expect(splitDuration(90.5)).toEqual({ value: 90.5, unit: 's' });
  });
});

describe('formatDuration', () => {
  it('formats sub-minute values', () => {
    expect(formatDuration(0.5)).toBe('0.5s');
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(12.25)).toBe('12.3s');
  });

  it('formats minutes and hours', () => {
    expect(formatDuration(150)).toBe('2m 30s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(3900)).toBe('1h 05m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(90_010)).toBe('25h 00m 10s');
  });

  it('handles invalid input', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatDurationLong', () => {
  it('uses the largest unit with pluralization', () => {
    expect(formatDurationLong(1)).toBe('1 second');
    expect(formatDurationLong(45)).toBe('45 seconds');
    expect(formatDurationLong(60)).toBe('1 minute');
    expect(formatDurationLong(1200)).toBe('20 minutes');
    expect(formatDurationLong(7200)).toBe('2 hours');
    expect(formatDurationLong(5400)).toBe('1.5 hours');
  });
});

describe('formatFrameDuration / formatElapsed', () => {
  it('formats frame counts at an fps', () => {
    expect(formatFrameDuration(900, 30)).toBe('30s');
    expect(formatFrameDuration(216_000, 30)).toBe('2h');
    expect(formatFrameDuration(10, 0)).toBe('—');
  });

  it('computes elapsed time between timestamps', () => {
    expect(formatElapsed('2026-10-09T08:00:00.000Z', '2026-10-09T08:02:30.000Z')).toBe('2m 30s');
    expect(formatElapsed(null, null)).toBeNull();
    expect(formatElapsed('2026-10-09T08:00:00.000Z', null, Date.parse('2026-10-09T08:00:05.000Z'))).toBe('5s');
  });
});
