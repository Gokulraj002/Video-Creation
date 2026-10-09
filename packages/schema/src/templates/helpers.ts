import type { TemplatePropsContext } from './types';

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const DEFAULT_PALETTE = ['#1E3A8A', '#F59E0B', '#0F172A', '#F8FAFC', '#10B981'] as const;

/** Collapses whitespace and truncates to `max` chars (with an ellipsis when cut). */
export function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  if (max <= 1) return clean.slice(0, max);
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Non-empty clipped text with a fallback. */
export function textOr(value: string | null | undefined, fallback: string, max: number): string {
  const clipped = value ? clip(value, max) : '';
  return clipped.length > 0 ? clipped : clip(fallback, max);
}

/** Clipped text or null when empty. */
export function textOrNull(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const clipped = clip(value, max);
  return clipped.length > 0 ? clipped : null;
}

/** Valid palette with at least `min` colors (defaults fill the gaps). */
export function paletteOf(ctx: TemplatePropsContext, min = 5): string[] {
  const valid = ctx.palette.filter((c) => HEX.test(c));
  const out = [...valid];
  for (const c of DEFAULT_PALETTE) {
    if (out.length >= min) break;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Relative luminance (0..1) of a #RRGGBB[AA] color. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Picks a readable text color for a background. */
export function readableOn(background: string): string {
  return luminance(background) > 0.45 ? '#0F172A' : '#FFFFFF';
}

/** Common colour roles derived from the context palette. */
export function colorsOf(ctx: TemplatePropsContext): { primary: string; accent: string; background: string; text: string } {
  const p = paletteOf(ctx);
  const primary = p[0] ?? DEFAULT_PALETTE[0];
  const accent = p[1] ?? DEFAULT_PALETTE[1];
  // Prefer the darkest remaining palette color as background for contrast with the accent.
  const candidates = p.slice(2);
  const background = candidates.reduce<string>(
    (darkest, c) => (luminance(c) < luminance(darkest) ? c : darkest),
    candidates[0] ?? DEFAULT_PALETTE[2],
  );
  return { primary, accent, background, text: readableOn(background) };
}

/** Deterministic 32-bit FNV-1a hash. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministically picks one of `options` from a seed string. */
export function pick<T>(options: readonly [T, ...T[]], seed: string): T {
  return options[hashString(seed) % options.length] ?? options[0];
}

/** Bullets (or sentences of the text, or the title) as 1..max clipped non-empty items. */
export function itemsOf(ctx: TemplatePropsContext, max: number, maxLength: number): string[] {
  const fromBullets = ctx.bullets.map((b) => clip(b, maxLength)).filter((b) => b.length > 0);
  if (fromBullets.length > 0) return fromBullets.slice(0, max);
  const fromText = (ctx.text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => clip(s, maxLength))
    .filter((s) => s.length > 0);
  if (fromText.length > 0) return fromText.slice(0, max);
  return [textOr(ctx.title, 'Key point', maxLength)];
}

/** Extracts the first number in a string (e.g. "Grew 42.5% in 2025" → 42.5). */
export function firstNumber(value: string): { value: number; decimals: number; suffix: string | null } | null {
  const match = /(-?\d+(?:[.,]\d+)?)\s*(%|x|k|m|\+)?/i.exec(value);
  if (!match || match[1] === undefined) return null;
  const raw = match[1].replace(',', '.');
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const decimals = Math.min(3, raw.includes('.') ? (raw.split('.')[1] ?? '').length : 0);
  return { value: n, decimals, suffix: match[2] ?? null };
}
