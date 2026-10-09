import { toWellFormedText } from '../common';
import type { TemplatePropsContext } from './types';

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const DEFAULT_PALETTE = ['#1E3A8A', '#F59E0B', '#0F172A', '#F8FAFC', '#10B981'] as const;

/**
 * Longest prefix of `value` (assumed well-formed) of at most `maxUnits` UTF-16 code units that never splits a
 * surrogate pair, i.e. it is cut on a code-point boundary. A trailing zero-width joiner is dropped too.
 */
function codePointPrefix(value: string, maxUnits: number): string {
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    const width = code >= 0xd800 && code <= 0xdbff && end + 1 < value.length ? 2 : 1;
    if (end + width > maxUnits) break;
    end += width;
  }
  return value.slice(0, end).replace(/\u200D+$/, '');
}

/**
 * Collapses whitespace and truncates to `max` UTF-16 code units (with an ellipsis when cut), so the result always fits
 * a Zod `.max(max)`. Cuts on code-point boundaries (never half of an emoji) and replaces lone surrogates already present
 * in the input with U+FFFD: the output is always well-formed (PostgreSQL `jsonb` rejects lone surrogates).
 */
export function clip(value: string, max: number): string {
  const clean = toWellFormedText(value).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  if (max <= 1) return codePointPrefix(clean, Math.max(0, max));
  return `${codePointPrefix(clean, max - 1).trimEnd()}…`;
}

/** Last-resort text when every candidate and the fallback are blank. */
const LAST_RESORT_TEXT = 'Untitled';

/** First non-blank candidate (whitespace-collapsed, clipped to `max`), else the fallback; never empty. */
export function firstText(candidates: readonly (string | null | undefined)[], fallback: string, max: number): string {
  for (const candidate of candidates) {
    const clipped = candidate ? clip(candidate, max) : '';
    if (clipped.length > 0) return clipped;
  }
  const fb = clip(fallback, max);
  return fb.length > 0 ? fb : clip(LAST_RESORT_TEXT, max);
}

/** Non-empty clipped text with a fallback (never empty). */
export function textOr(value: string | null | undefined, fallback: string, max: number): string {
  return firstText([value], fallback, max);
}

/** First non-blank candidate (clipped) or null when every candidate is blank. */
export function firstTextOrNull(candidates: readonly (string | null | undefined)[], max: number): string | null {
  for (const candidate of candidates) {
    const clipped = candidate ? clip(candidate, max) : '';
    if (clipped.length > 0) return clipped;
  }
  return null;
}

/** Clipped text or null when empty. */
export function textOrNull(value: string | null | undefined, max: number): string | null {
  return firstTextOrNull([value], max);
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

/**
 * Extracts the first number in a string (e.g. "Grew 42.5% in 2025" → 42.5, "1,250 users" → 1250,
 * "3,5x" → 3.5). Comma groups of exactly three digits are thousands separators; otherwise a comma is a decimal mark.
 */
export function firstNumber(value: string): { value: number; decimals: number; suffix: string | null } | null {
  const match = /(-?\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|-?\d+(?:[.,]\d+)?)(?:\s*(%|\+|(?:x|k|m)(?![a-z])))?/i.exec(value);
  if (!match || match[1] === undefined) return null;
  const token = match[1];
  const raw = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token) ? token.replace(/,/g, '') : token.replace(',', '.');
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const decimals = Math.min(3, raw.includes('.') ? (raw.split('.')[1] ?? '').length : 0);
  return { value: n, decimals, suffix: match[2] ?? null };
}
