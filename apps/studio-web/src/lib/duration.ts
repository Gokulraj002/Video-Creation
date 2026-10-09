/**
 * Duration helpers for the project form and the UI. Pure + isomorphic (unit-tested).
 * There is deliberately NO hardcoded maximum here: the configured limit comes from `GET /v1/system/config`.
 */

export const DURATION_UNITS = ['s', 'min', 'h'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const DURATION_UNIT_SECONDS: Readonly<Record<DurationUnit, number>> = {
  s: 1,
  min: 60,
  h: 3600,
};

export const DURATION_UNIT_LABELS: Readonly<Record<DurationUnit, string>> = {
  s: 'seconds',
  min: 'minutes',
  h: 'hours',
};

export function isDurationUnit(value: unknown): value is DurationUnit {
  return typeof value === 'string' && (DURATION_UNITS as readonly string[]).includes(value);
}

/** Converts `value` in `unit` to seconds (rounded to milliseconds to avoid float noise such as 0.1 h). */
export function toSeconds(value: number, unit: DurationUnit): number {
  return Math.round(value * DURATION_UNIT_SECONDS[unit] * 1000) / 1000;
}

export type ParseDurationResult = { ok: true; seconds: number } | { ok: false; error: string };

/**
 * Parses the raw duration form inputs (value + unit). Accepts `1.5`, `1,5` (decimal comma) and surrounding
 * whitespace; rejects empty, non-numeric, non-finite and non-positive values.
 */
export function parseDurationInput(rawValue: string | null | undefined, rawUnit: string | null | undefined): ParseDurationResult {
  const unit = (rawUnit ?? 's').trim();
  if (!isDurationUnit(unit)) {
    return { ok: false, error: `Unknown duration unit "${unit}"` };
  }
  const text = (rawValue ?? '').trim().replace(',', '.');
  if (text === '') {
    return { ok: false, error: 'Enter a duration' };
  }
  if (!/^\d*\.?\d+$/.test(text)) {
    return { ok: false, error: 'Duration must be a positive number' };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Duration must be greater than zero' };
  }
  const seconds = toSeconds(value, unit);
  if (seconds <= 0) {
    return { ok: false, error: 'Duration is too short' };
  }
  return { ok: true, seconds };
}

/** Picks the largest unit that represents `seconds` as a whole number, for pre-filling forms. */
export function splitDuration(seconds: number): { value: number; unit: DurationUnit } {
  for (const unit of ['h', 'min'] as const) {
    const size = DURATION_UNIT_SECONDS[unit];
    if (seconds >= size && Number.isInteger(seconds / size)) {
      return { value: seconds / size, unit };
    }
  }
  return { value: seconds, unit: 's' };
}

function trimZeros(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

/**
 * Compact human duration: `0.5s`, `45s`, `2m 30s`, `10m`, `1h 05m`, `2h`, `25h 00m 10s`.
 * Sub-minute values keep up to one decimal; longer values are rounded to whole seconds.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) {
    return `${trimZeros(seconds, seconds < 10 ? 2 : 1)}s`;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  if (h > 0) {
    if (s > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
    if (m > 0) return `${h}h ${pad(m)}m`;
    return `${h}h`;
  }
  return s > 0 ? `${m}m ${pad(s)}s` : `${m}m`;
}

/** Long form for limits and help text: `45 seconds`, `20 minutes`, `2 hours`, `1.5 hours`. */
export function formatDurationLong(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const plural = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`;
  if (seconds >= 3600) return plural(Number(trimZeros(seconds / 3600, 2)), 'hour');
  if (seconds >= 60) return plural(Number(trimZeros(seconds / 60, 2)), 'minute');
  return plural(Number(trimZeros(seconds, 2)), 'second');
}

/** Duration of an integer frame count at `fps`, formatted with `formatDuration`. */
export function formatFrameDuration(frames: number, fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '—';
  return formatDuration(frames / fps);
}

/** Elapsed time between two ISO timestamps (or until `now`), formatted; `null` when `start` is missing. */
export function formatElapsed(startIso: string | null, endIso: string | null, now: number = Date.now()): string | null {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return formatDuration(Math.max(0, (end - start) / 1000));
}
