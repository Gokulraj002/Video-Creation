import type { BrandColors, CaptionItem, CaptionTrack, JsonValue, SceneContent, Timeline, Transition } from '@vc/schema';

/** Pure helpers behind the Remotion animatic (unit-tested; no React / Remotion imports). */

const HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

export const DEFAULT_BRAND_COLORS: Readonly<BrandColors> = {
  primary: '#6366f1',
  secondary: '#0ea5e9',
  accent: '#f59e0b',
  background: '#0f172a',
  text: '#f8fafc',
};

export function resolveBrandColors(timeline: Pick<Timeline, 'brand'>): BrandColors {
  return { ...DEFAULT_BRAND_COLORS, ...(timeline.brand?.colors ?? {}) };
}

/** Relative luminance (WCAG) of a #rrggbb[aa] color; alpha is ignored. */
export function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Near-white or near-black, whichever reads better on `background`. */
export function readableTextColor(background: string): string {
  if (!isHexColor(background)) return '#f8fafc';
  return relativeLuminance(background) > 0.4 ? '#0b0d12' : '#f8fafc';
}

function prop(props: Record<string, JsonValue>, key: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
}

function str(props: Record<string, JsonValue>, key: string): string | null {
  const value = prop(props, key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function strList(props: Record<string, JsonValue>, key: string): string[] {
  const value = prop(props, key);
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

function templateOf(content: SceneContent): { template: string; props: Record<string, JsonValue> } | null {
  return content.engine === 'motion2d' || content.engine === 'three'
    ? { template: content.template, props: content.props }
    : null;
}

/** Formats a stat-counter value with its decimals / prefix / suffix. */
function statText(props: Record<string, JsonValue>): string | null {
  const value = prop(props, 'value');
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const decimalsRaw = prop(props, 'decimals');
  const decimals = typeof decimalsRaw === 'number' ? Math.max(0, Math.min(3, Math.trunc(decimalsRaw))) : 0;
  const formatted = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${str(props, 'prefix') ?? ''}${formatted}${str(props, 'suffix') ?? ''}`;
}

/**
 * The scene's main on-screen line, derived from the template props (headline, quote, lines, title, value…).
 * Falls back to `fallback` (the scene title) when the content has no text.
 */
export function primaryTemplateText(content: SceneContent, fallback: string): string {
  const tpl = templateOf(content);
  if (!tpl) {
    if (content.engine === 'generated') return content.prompt.trim() || fallback;
    return fallback;
  }
  const { template, props } = tpl;
  const lines = strList(props, 'lines');
  return (
    str(props, 'headline') ??
    str(props, 'quote') ??
    (lines.length > 0 ? lines.join(' ') : null) ??
    (template === 'stat-counter' ? statText(props) : null) ??
    str(props, 'title') ??
    str(props, 'propertyName') ??
    str(props, 'text') ??
    str(props, 'name') ??
    str(props, 'dialogue') ??
    str(props, 'callToAction') ??
    fallback
  );
}

/** Supporting text lines (bullets, subheadline, instruction, attribution…), at most `max`. */
export function secondaryTemplateLines(content: SceneContent, max = 4): string[] {
  const tpl = templateOf(content);
  if (!tpl) return [];
  const { template, props } = tpl;
  const bullets = [...strList(props, 'bullets'), ...strList(props, 'features')];
  if (bullets.length > 0) return bullets.slice(0, max);
  const candidates: (string | null)[] = [];
  switch (template) {
    case 'stat-counter':
      candidates.push(str(props, 'label'));
      break;
    case 'step-instruction': {
      const step = prop(props, 'stepNumber');
      const total = prop(props, 'totalSteps');
      if (typeof step === 'number' && typeof total === 'number') candidates.push(`Step ${step} of ${total}`);
      candidates.push(str(props, 'instruction'), str(props, 'caution') ? `⚠ ${str(props, 'caution')}` : null);
      break;
    }
    case 'quote':
      candidates.push(str(props, 'attribution') ? `— ${str(props, 'attribution')}` : null);
      break;
    case 'cta-end-card':
      candidates.push(str(props, 'callToAction'), str(props, 'contactLine'));
      break;
    case 'property-showcase':
      candidates.push(str(props, 'location'), str(props, 'price'));
      break;
    case 'lower-third':
      candidates.push(str(props, 'role'));
      break;
    default:
      candidates.push(str(props, 'subheadline'), str(props, 'body'), str(props, 'emphasis'));
  }
  return candidates.filter((c): c is string => c !== null).slice(0, max);
}

/** Background + accent colors for a scene card: template props when valid hex, otherwise the brand kit. */
export function sceneColors(content: SceneContent, brand: BrandColors): { background: string; accent: string; gradient: string[] | null } {
  const props = templateOf(content)?.props ?? null;
  let background = brand.background;
  let accent = brand.accent;
  let gradient: string[] | null = null;
  if (props) {
    const bg = prop(props, 'backgroundColor');
    if (isHexColor(bg)) background = bg;
    const ac = prop(props, 'accentColor') ?? prop(props, 'color');
    if (isHexColor(ac)) accent = ac;
    const bgSpec = prop(props, 'background');
    if (bgSpec && typeof bgSpec === 'object' && !Array.isArray(bgSpec)) {
      const colors = Array.isArray(bgSpec.colors) ? bgSpec.colors.filter(isHexColor) : [];
      if (colors[0]) background = colors[0];
      if (bgSpec.style === 'gradient' && colors.length >= 2) gradient = colors;
    }
    const palette = prop(props, 'palette');
    if (Array.isArray(palette)) {
      const colors = palette.filter(isHexColor);
      if (colors.length >= 2) gradient = colors.slice(0, 3);
    }
  }
  return { background, accent, gradient };
}

export interface FrameSpan {
  startFrame: number;
  durationInFrames: number;
}

/** Binary search for the span containing `frame` (spans sorted by startFrame, non-overlapping); -1 when none. */
export function findSpanIndex(spans: readonly FrameSpan[], frame: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (!span) return -1;
    if (frame < span.startFrame) hi = mid - 1;
    else if (frame >= span.startFrame + span.durationInFrames) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The first caption track of the timeline (M1 compiles at most one). */
export function primaryCaptionTrack(timeline: Pick<Timeline, 'tracks'>): CaptionTrack | null {
  for (const track of timeline.tracks) if (track.kind === 'caption') return track;
  return null;
}

/** The caption cue visible at absolute `frame`, if any. */
export function activeCaption(track: CaptionTrack | null, frame: number): CaptionItem | null {
  if (!track) return null;
  const index = findSpanIndex(track.items, frame);
  return index >= 0 ? (track.items[index] ?? null) : null;
}

/** Effective transition length in frames for a scene (0 for none / cut, clamped to the scene length). */
export function transitionFrames(transition: Transition | undefined, sceneDurationInFrames: number): number {
  if (!transition || transition.type === 'cut') return 0;
  return Math.max(0, Math.min(transition.durationInFrames, sceneDurationInFrames));
}

/** Linear 0→1 progress of an incoming transition at a scene-relative frame (1 when there is no transition). */
export function transitionProgress(localFrame: number, frames: number): number {
  if (frames <= 0) return 1;
  return Math.max(0, Math.min(1, localFrame / frames));
}

/** Smoothstep easing for transitions and text entrances. */
export function easeInOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
