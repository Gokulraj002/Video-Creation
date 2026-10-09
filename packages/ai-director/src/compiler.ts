import {
  allocateFrames,
  checkTimelineLimits,
  CURRENT_TIMELINE_VERSION,
  expandCameraPreset,
  formatZodIssues,
  IdSchema,
  resolveDimensions,
  secondsToFrames,
  TimelineSchema,
  type AssetRef,
  type BrandKit,
  type CaptionItem,
  type CaptionTrack,
  type Chapter,
  type DirectorArtifacts,
  type ResourceLimits,
  type Scene,
  type SceneContent,
  type SceneSpec,
  type ShotList,
  type StoryboardScene,
  type ThreeContent,
  type Timeline,
  type Transition,
  type VideoRequest,
} from '@vc/schema';
import { cameraPresetForMovement } from './camera-mapping';
import { InternalDirectorError, LimitExceededError, ValidationFailedError } from './errors';
import { genreProfile } from './genres';
import { isHexColor, luminance, readableOn, uniqueHexColors } from './util/color';
import { clip, words } from './util/text';

export const GENERATOR_NAME = 'vc-ai-director';
export const GENERATOR_VERSION = '0.1.0';
export const DEFAULT_FONT = 'Inter';
/** Max words (word-like units for languages written without spaces) per caption cue. */
export const CAPTION_MAX_WORDS = 7;
/** Max characters (code points) per caption cue. */
export const CAPTION_MAX_CUE_CHARS = 80;
/** Tokens longer than this (code points) are split with `Intl.Segmenter` (ja, zh, th... are written without spaces). */
export const CAPTION_MAX_UNIT_CHARS = 24;
/** Fixed chunk size (code points) when a token cannot be segmented into words. */
export const CAPTION_FALLBACK_CHUNK_CHARS = 12;
/** Max length of one caption cue text (schema limit). */
const CAPTION_TEXT_MAX = 500;
/** Id of the generated caption track. */
export const CAPTION_TRACK_ID = 'captions';

/**
 * Ids the director generates: timeline chapters `c{n}`, scenes `c{n}-s{m}`, caption cues `c{n}-s{m}-cap{k}`, the
 * `captions` track (all in the timeline's global id namespace), plus artifact shot ids `sh{n}` and script segment ids
 * `c{n}-g{k}`. Input asset ids must not match (the timeline would contain duplicate ids).
 */
export const RESERVED_ID_PATTERN = /^(?:captions|c\d+(?:-(?:s\d+(?:-cap\d+)?|g\d+))?|sh\d+)$/;

/** True when `id` is one of the ids the director generates (see {@link RESERVED_ID_PATTERN}). */
export function isReservedId(id: string): boolean {
  return RESERVED_ID_PATTERN.test(id);
}

export interface CompileInput {
  request: VideoRequest;
  artifacts: DirectorArtifacts;
  assets: readonly AssetRef[];
  limits: ResourceLimits;
  promptVersion: string;
  timelineId: string;
  /** ISO timestamp for `metadata.createdAt` (omitted when null). */
  createdAt: string | null;
}

export interface CompileResult {
  timeline: Timeline;
  warnings: string[];
}

const DEFAULT_COLORS = { primary: '#1E3A8A', secondary: '#F59E0B', accent: '#10B981', background: '#0F172A' } as const;

/** Alpha channel (0..255) of a #RRGGBB[AA] color (255 when absent). */
function alphaOf(hex: string): number {
  return hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255;
}

/** Brand kit from the request brand colors + brief palette, with sensible defaults. */
export function buildBrandKit(request: VideoRequest, palette: readonly string[], assets: readonly AssetRef[], warnings: string[]): BrandKit {
  // Fully transparent colors are meaningless in a brand kit; the background must be opaque (translucent colors
  // would let whatever is behind the video show through).
  const brandColors = uniqueHexColors(request.brand?.colors ?? []).filter((c) => alphaOf(c) > 0);
  const colors = uniqueHexColors([...brandColors, ...palette]).filter((c) => alphaOf(c) > 0);
  const opaque = (list: readonly string[]) => list.filter((c) => alphaOf(c) === 255);
  const darkestOf = (list: readonly string[]) =>
    list.reduce<string | null>((best, c) => (best === null || luminance(c) < luminance(best) ? c : best), null);
  // Background: the darkest opaque brand color when the brand has a dark one, else the darkest opaque palette color.
  const darkBrand = darkestOf(opaque(brandColors));
  const darkest = darkBrand !== null && luminance(darkBrand) < 0.2 ? darkBrand : darkestOf(opaque(colors));
  const background = darkest !== null && luminance(darkest) < 0.2 ? darkest : DEFAULT_COLORS.background;
  const rest = colors.filter((c) => c !== background);
  const primary = rest[0] ?? DEFAULT_COLORS.primary;
  const secondary = rest[1] ?? DEFAULT_COLORS.secondary;
  const accent = rest[2] ?? (secondary !== DEFAULT_COLORS.accent ? DEFAULT_COLORS.accent : DEFAULT_COLORS.secondary);
  const kit: BrandKit = {
    colors: { primary, secondary, accent, background, text: readableOn(background) },
    fonts: { heading: request.brand?.fontHeading ?? DEFAULT_FONT, body: request.brand?.fontBody ?? DEFAULT_FONT },
  };
  if (request.brand?.name) kit.name = clip(request.brand.name, 120);
  const logo = request.brand?.logoAssetId;
  if (logo !== undefined) {
    const asset = assets.find((a) => a.id === logo);
    if (asset && asset.kind === 'image') kit.logoAssetId = logo;
    else warnings.push(`Brand logo "${logo}" is not an available image asset; the logo was omitted.`);
  }
  return kit;
}

function transitionFor(scene: StoryboardScene, index: number, frames: readonly number[], fps: number): Transition | undefined {
  if (index === 0) return undefined;
  if (scene.transitionIn === 'cut') return { type: 'cut', durationInFrames: 0, easing: 'linear' };
  const adjacent = Math.min(frames[index] ?? 1, frames[index - 1] ?? 1);
  const duration = Math.min(Math.round(0.5 * fps), Math.floor(adjacent / 2));
  if (duration < 1) return { type: 'cut', durationInFrames: 0, easing: 'linear' };
  const transition: Transition = { type: scene.transitionIn, durationInFrames: duration, easing: 'ease-in-out' };
  if (scene.transitionIn === 'slide' || scene.transitionIn === 'wipe') transition.direction = 'left';
  return transition;
}

/** One caption word (or word-like unit); `spaceBefore` = it started a whitespace-separated token. */
interface CaptionUnit {
  text: string;
  spaceBefore: boolean;
  chars: number;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function chunkCodePoints(text: string, size: number): string[] {
  const points = [...text];
  const out: string[] = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(''));
  return out;
}

const SEGMENTERS = new Map<string, Intl.Segmenter | null>();

function wordSegmenter(language: string): Intl.Segmenter | null {
  if (SEGMENTERS.has(language)) return SEGMENTERS.get(language) ?? null;
  let segmenter: Intl.Segmenter | null = null;
  try {
    segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(language, { granularity: 'word' }) : null;
  } catch {
    segmenter = null;
  }
  SEGMENTERS.set(language, segmenter);
  return segmenter;
}

/**
 * Splits a long token (a whole sentence in languages written without spaces, an emoji run...) into word-like
 * pieces with `Intl.Segmenter` (punctuation sticks to the preceding word); pieces that are still too long — or every
 * piece when no segmenter is available — are cut into fixed code-point chunks. Nothing is dropped.
 */
function splitLongToken(token: string, language: string): string[] {
  const pieces: string[] = [];
  const segmenter = wordSegmenter(language);
  if (segmenter) {
    for (const part of segmenter.segment(token)) {
      const last = pieces.length - 1;
      if (!part.isWordLike && last >= 0) pieces[last] = `${pieces[last] ?? ''}${part.segment}`;
      else pieces.push(part.segment);
    }
  } else {
    pieces.push(token);
  }
  return pieces.flatMap((p) => (codePointLength(p) > CAPTION_MAX_UNIT_CHARS ? chunkCodePoints(p, CAPTION_FALLBACK_CHUNK_CHARS) : [p]));
}

function captionUnits(text: string, language: string): CaptionUnit[] {
  const units: CaptionUnit[] = [];
  for (const token of words(text)) {
    const pieces = codePointLength(token) > CAPTION_MAX_UNIT_CHARS ? splitLongToken(token, language) : [token];
    pieces.forEach((piece, k) => {
      if (piece.length > 0) units.push({ text: piece, spaceBefore: k === 0, chars: codePointLength(piece) });
    });
  }
  return units;
}

function cueText(units: readonly CaptionUnit[]): string {
  return units.map((u, i) => (i > 0 && u.spaceBefore ? ` ${u.text}` : u.text)).join('');
}

/** Groups units into cues of ≤ `CAPTION_MAX_WORDS` units and ≤ `CAPTION_MAX_CUE_CHARS` characters. */
function groupCues(units: readonly CaptionUnit[]): CaptionUnit[][] {
  const cues: CaptionUnit[][] = [];
  let current: CaptionUnit[] = [];
  let chars = 0;
  for (const unit of units) {
    const extra = unit.chars + (current.length > 0 && unit.spaceBefore ? 1 : 0);
    if (current.length > 0 && (current.length >= CAPTION_MAX_WORDS || chars + extra > CAPTION_MAX_CUE_CHARS)) {
      cues.push(current);
      current = [];
      chars = 0;
    }
    chars += current.length > 0 ? extra : unit.chars;
    current.push(unit);
  }
  if (current.length > 0) cues.push(current);
  return cues;
}

/**
 * Caption cues of ≤ 7 words (word-segmented with `Intl.Segmenter` for languages written without spaces), frames
 * proportional to word count, contiguous over the scene. When there are more cues than frames, words are regrouped
 * into fewer, longer cues; text is only cut (with a warning) when a cue would exceed the 500-character limit.
 */
function captionCues(sceneId: string, text: string, language: string, startFrame: number, frames: number, warnings: string[]): CaptionItem[] {
  const units = captionUnits(text, language);
  if (units.length === 0) return [];
  let cues = groupCues(units);
  if (cues.length > frames) {
    const perCue = Math.ceil(units.length / frames);
    cues = [];
    for (let i = 0; i < units.length; i += perCue) cues.push(units.slice(i, i + perCue));
  }
  const allocation = allocateFrames(
    cues.map((c) => c.length),
    frames,
    1,
  );
  const items: CaptionItem[] = [];
  let truncated = false;
  let cursor = startFrame;
  cues.forEach((cue, k) => {
    const d = allocation[k] ?? 1;
    const full = cueText(cue).replace(/\s+/g, ' ').trim();
    if (full.length > CAPTION_TEXT_MAX) truncated = true;
    items.push({ id: `${sceneId}-cap${k + 1}`, startFrame: cursor, durationInFrames: d, text: clip(full, CAPTION_TEXT_MAX) });
    cursor += d;
  });
  if (truncated) warnings.push(`Scene "${sceneId}": narration is too long for ${frames} frame(s); captions were truncated.`);
  return items;
}

/** Frame-allocation weights from storyboard durations: finite and > 0, rescaled when absurdly large (no overflow). */
function durationWeights(storyboard: readonly StoryboardScene[]): number[] {
  const issues: string[] = [];
  storyboard.forEach((s, i) => {
    if (!Number.isFinite(s.durationSeconds) || s.durationSeconds <= 0) {
      issues.push(`storyboard.scenes.${i}.durationSeconds: must be a finite number > 0 (got ${String(s.durationSeconds)})`);
    }
  });
  if (issues.length > 0) throw new ValidationFailedError('Storyboard scene durations are invalid', issues, { stage: 'compile' });
  const durations = storyboard.map((s) => s.durationSeconds);
  const largest = durations.reduce((a, b) => Math.max(a, b), 0);
  // Only relative durations matter; normalizing huge values keeps the allocation arithmetic finite.
  return largest > 1e6 ? durations.map((d) => Math.max(d / largest, 1e-9)) : durations;
}

function contentFor(
  spec: SceneSpec,
  request: VideoRequest,
  assets: readonly AssetRef[],
  warnings: string[],
): SceneContent {
  const profile = genreProfile(request.genre);
  const props = { ...spec.props };
  // Never let template props point at assets that do not exist (or are not images).
  if ('imageAssetId' in props && props.imageAssetId !== null) {
    const id = props.imageAssetId;
    const ok = typeof id === 'string' && assets.some((a) => a.id === id && a.kind === 'image');
    if (!ok) {
      warnings.push(`Scene "${spec.sceneId}": imageAssetId "${String(id)}" is not an available image asset; using the image prompt instead.`);
      props.imageAssetId = null;
    }
  }
  if (spec.engine === 'three') {
    const content: ThreeContent = {
      engine: 'three',
      template: spec.template,
      props,
      environment: profile.threeEnvironment,
      lighting: profile.threeLighting,
    };
    const model = spec.template === 'product-turntable' ? assets.find((a) => a.kind === 'model3d') : undefined;
    if (model) content.modelAssetId = model.id;
    return content;
  }
  return { engine: 'motion2d', template: spec.template, props, layers: [] };
}

function firstShotPreset(shotList: ShotList, sceneId: string) {
  const entry = shotList.scenes.find((s) => s.sceneId === sceneId);
  const movement = entry?.shots[0]?.cameraMovement;
  return movement ? cameraPresetForMovement(movement) : 'static';
}

/**
 * Deterministic compilation of director artifacts into a validated v1 timeline:
 * frame allocation (sum exact), chapters as spans of their scenes, template content, cameras, transitions,
 * narration, one caption track, brand kit and metadata. Throws `LIMIT_EXCEEDED` on limit violations.
 */
export function compileTimeline(input: CompileInput): CompileResult {
  const { request, artifacts, assets, limits } = input;
  const warnings: string[] = [];
  const { width, height } = resolveDimensions(request);
  const fps = request.fps;
  const totalFrames = Math.max(1, secondsToFrames(request.durationSeconds, fps));
  const storyboard = artifacts.storyboard.scenes;
  const sceneCount = storyboard.length;
  if (sceneCount === 0) throw new InternalDirectorError('Cannot compile a timeline without scenes');
  if (sceneCount > totalFrames) {
    throw new LimitExceededError(`${sceneCount} scenes cannot fit in ${totalFrames} frames`, [
      { code: 'MAX_SCENES', message: `Scene count ${sceneCount} exceeds the ${totalFrames} available frames`, limit: totalFrames, actual: sceneCount },
    ]);
  }
  const minFrames = Math.max(1, Math.min(fps, Math.floor(totalFrames / sceneCount)));
  const frames = allocateFrames(durationWeights(storyboard), totalFrames, minFrames);

  const specs = new Map(artifacts.sceneSpecs.scenes.map((s) => [s.sceneId, s]));
  const brand = buildBrandKit(request, artifacts.brief.visualStyle.palette, assets, warnings);
  const narrate = request.voiceOver.enabled;

  const scenes: Scene[] = [];
  const captions: CaptionItem[] = [];
  let cursor = 0;
  storyboard.forEach((sb, i) => {
    const duration = frames[i] ?? 1;
    const spec = specs.get(sb.id);
    if (!spec) throw new InternalDirectorError(`Missing scene spec for scene "${sb.id}"`);
    const content = contentFor(spec, request, assets, warnings);
    const preset = spec.cameraPreset ?? firstShotPreset(artifacts.shotList, sb.id);
    const scene: Scene = {
      id: sb.id,
      chapterId: sb.chapterId,
      title: clip(sb.title, 200),
      startFrame: cursor,
      durationInFrames: duration,
      content,
      camera: expandCameraPreset(preset, content.engine === 'three' ? '3d' : '2d', duration),
      notes: clip(sb.visualDescription, 2000),
      storyboardSceneId: sb.id,
    };
    const transition = transitionFor(sb, i, frames, fps);
    if (transition) scene.transitionIn = transition;
    const voiceOver = sb.voiceOver?.trim() ?? '';
    if (narrate && voiceOver.length > 0) {
      scene.narration = { text: clip(voiceOver, 5000), language: request.language };
      captions.push(...captionCues(sb.id, voiceOver, request.language, cursor, duration, warnings));
    }
    scenes.push(scene);
    cursor += duration;
  });

  const chapters: Chapter[] = [];
  for (const outlineChapter of artifacts.outline.chapters) {
    const members = scenes.filter((s) => s.chapterId === outlineChapter.id);
    const first = members[0];
    const last = members[members.length - 1];
    if (!first || !last) {
      warnings.push(`Chapter "${outlineChapter.id}" has no scenes and was omitted from the timeline.`);
      continue;
    }
    chapters.push({
      id: outlineChapter.id,
      title: clip(outlineChapter.title, 200),
      summary: clip(outlineChapter.summary, 2000),
      startFrame: first.startFrame,
      durationInFrames: last.startFrame + last.durationInFrames - first.startFrame,
    });
  }

  const profile = genreProfile(request.genre);
  const tracks: CaptionTrack[] = [];
  if (captions.length > 0) {
    tracks.push({
      id: CAPTION_TRACK_ID,
      kind: 'caption',
      name: 'Captions',
      language: request.language,
      style: {
        preset: profile.captionPreset,
        // 'bold-center' means bold, horizontally centred text. Template scenes put their headline
        // in the middle of the frame, so captions stay at the bottom for every genre.
        position: 'bottom',
        fontFamily: brand.fonts.body,
        color: '#FFFFFF',
        backgroundColor: '#000000B3',
      },
      items: captions,
    });
  }

  const timelineId = IdSchema.safeParse(input.timelineId).success ? input.timelineId : `tl-${Date.now().toString(36)}`;
  const draft = {
    schemaVersion: CURRENT_TIMELINE_VERSION,
    id: timelineId,
    title: clip(request.title, 200),
    settings: {
      width,
      height,
      fps,
      backgroundColor: isHexColor(brand.colors.background) ? brand.colors.background : DEFAULT_COLORS.background,
      sampleRate: 48000 as const,
      videoCodec: 'h264' as const,
      audioCodec: 'aac' as const,
    },
    durationInFrames: totalFrames,
    brand,
    assets: [...assets],
    chapters,
    scenes,
    tracks,
    metadata: {
      generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION, promptVersion: input.promptVersion },
      language: request.language,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  };

  const parsed = TimelineSchema.safeParse(draft);
  if (!parsed.success) {
    throw new InternalDirectorError(`Compiled timeline failed validation: ${formatZodIssues(parsed.error, 10).join('; ')}`, {
      stage: 'compile',
      details: { issues: formatZodIssues(parsed.error, 50) },
    });
  }
  const violations = checkTimelineLimits(parsed.data, limits);
  if (violations.length > 0) {
    throw new LimitExceededError(violations.map((v) => v.message).join('; '), violations, { stage: 'compile' });
  }
  return { timeline: parsed.data, warnings };
}
