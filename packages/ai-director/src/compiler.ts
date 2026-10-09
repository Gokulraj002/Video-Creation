import {
  allocateFrames,
  checkTimelineLimits,
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
import { InternalDirectorError, LimitExceededError } from './errors';
import { genreProfile } from './genres';
import { isHexColor, luminance, readableOn, uniqueHexColors } from './util/color';
import { clip, words } from './util/text';

export const GENERATOR_NAME = 'vc-ai-director';
export const GENERATOR_VERSION = '0.1.0';
export const DEFAULT_FONT = 'Inter';
/** Max words per caption cue. */
export const CAPTION_MAX_WORDS = 7;

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

/** Brand kit from the request brand colors + brief palette, with sensible defaults. */
export function buildBrandKit(request: VideoRequest, palette: readonly string[], assets: readonly AssetRef[], warnings: string[]): BrandKit {
  const brandColors = uniqueHexColors(request.brand?.colors ?? []);
  const colors = uniqueHexColors([...brandColors, ...palette]);
  const darkestOf = (list: readonly string[]) =>
    list.reduce<string | null>((best, c) => (best === null || luminance(c) < luminance(best) ? c : best), null);
  // Background: the darkest brand color when the brand has a dark one, else the darkest palette color.
  const darkBrand = darkestOf(brandColors);
  const darkest = darkBrand !== null && luminance(darkBrand) < 0.2 ? darkBrand : darkestOf(colors);
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

/** Caption cues of ≤ 7 words, frames proportional to word count, contiguous over the scene. */
function captionCues(sceneId: string, text: string, startFrame: number, frames: number, warnings: string[]): CaptionItem[] {
  const w = words(text);
  if (w.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < w.length; i += CAPTION_MAX_WORDS) chunks.push(w.slice(i, i + CAPTION_MAX_WORDS));
  let cues = chunks;
  if (cues.length > frames) {
    cues = chunks.slice(0, frames);
    warnings.push(`Scene "${sceneId}": narration is too long for ${frames} frame(s); captions were truncated.`);
  }
  const allocation = allocateFrames(
    cues.map((c) => c.length),
    frames,
    1,
  );
  const items: CaptionItem[] = [];
  let cursor = startFrame;
  cues.forEach((cue, k) => {
    const d = allocation[k] ?? 1;
    items.push({ id: `${sceneId}-cap${k + 1}`, startFrame: cursor, durationInFrames: d, text: clip(cue.join(' '), 500) });
    cursor += d;
  });
  return items;
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
  const frames = allocateFrames(
    storyboard.map((s) => s.durationSeconds),
    totalFrames,
    minFrames,
  );

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
      captions.push(...captionCues(sb.id, voiceOver, cursor, duration, warnings));
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
      id: 'captions',
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
    schemaVersion: 1 as const,
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
