/** Text helpers shared by the compiler, prompts and the heuristic mock. */

/** Collapses whitespace and truncates to `max` chars (with an ellipsis when cut). */
export function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  if (max <= 1) return clean.slice(0, max);
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Non-empty clipped text, or the clipped fallback. */
export function clipOr(value: string | null | undefined, fallback: string, max: number): string {
  const clipped = value ? clip(value, max) : '';
  return clipped.length > 0 ? clipped : clip(fallback, max);
}

/** Clipped text, or null when empty. */
export function clipOrNull(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const clipped = clip(value, max);
  return clipped.length > 0 ? clipped : null;
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

export function countWords(text: string): number {
  return words(text).length;
}

/** Truncates text to at most `maxWords` words, ending with a period. */
export function limitWords(text: string, maxWords: number): string {
  const w = words(text);
  if (w.length <= maxWords) return w.join(' ');
  const cut = w.slice(0, Math.max(1, maxWords)).join(' ').replace(/[,;:\-–—]+$/, '');
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/** Splits prose into sentences / lines. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s\-*•\d.)]+/, '').trim())
    .filter((s) => s.length > 0);
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Ensures a sentence ends with terminal punctuation. */
export function sentence(text: string): string {
  const t = text.trim();
  if (t.length === 0) return t;
  return /[.!?…]$/.test(t) ? capitalize(t) : `${capitalize(t)}.`;
}

/** Rounds to `digits` decimals (avoids float noise like 2.3000000000000003 in artifacts). */
export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
