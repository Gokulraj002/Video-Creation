/** Display formatting helpers (pure, locale pinned to en-US so server and client output match). */

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? integerFormat.format(value) : '—';
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) < 10_000 ? integerFormat.format(value) : compactFormat.format(value);
}

/** USD with adaptive precision: `$0.00`, `$0.0042`, `$1.23`, `$1,234.50`. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  const abs = Math.abs(value);
  const digits = abs < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** Absolute timestamp in UTC (stable across server/client): `Oct 9, 2026, 08:25 UTC`. */
export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dateTimeFormat.format(t) : '—';
}

/** Relative time against `now`: `just now`, `5 min ago`, `3 h ago`, `2 days ago`, else an absolute date. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diffSeconds = Math.round((now - t) / 1000);
  if (diffSeconds < 0) return formatDateTime(iso);
  if (diffSeconds < 45) return 'just now';
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDateTime(iso);
}

/** `motion-graphics` → `Motion graphics`, `sop-training` → `SOP training`. */
export function humanizeSlug(slug: string): string {
  const acronyms = new Set(['sop', 'cta', 'vo', 'ai', '3d', '2d']);
  const words = slug.split(/[-_]/g).filter(Boolean);
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** Clips text to `max` characters on a word boundary when possible, adding an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, Math.max(0, max - 1));
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}
