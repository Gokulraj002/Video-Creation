import {
  EngineTypeSchema,
  ShotSchema,
  ShotTypeSchema,
  TransitionTypeSchema,
  type DirectorArtifacts,
  type Timeline,
} from '@vc/schema';
import { z } from 'zod';
import { primaryTemplateText } from './animatic';

/**
 * Joins director artifacts (storyboard, shot list, engine selection, scene specs) with the compiled timeline so
 * the UI can show one card per scene with exact frames. Pure (unit-tested).
 *
 * Multi-hour timelines have thousands of scenes, so the page never renders (or serializes) all of them: it renders
 * chapter headers plus an initial budget of cards (`planStoryboard`), and the browser loads further cards per chapter
 * from `/api/projects/:id/versions/:version/storyboard` (`pageChapterRows`, validated with `StoryboardPageSchema`).
 */

const NullableText = z.string().nullable();

export const StoryboardRowSchema = z.object({
  index: z.number().int().min(0),
  id: z.string().min(1),
  title: z.string(),
  startFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1),
  engine: EngineTypeSchema,
  template: NullableText,
  engineRationale: NullableText,
  cameraPreset: NullableText,
  shotType: ShotTypeSchema.nullable(),
  mood: NullableText,
  transitionIn: TransitionTypeSchema.nullable(),
  visualDescription: NullableText,
  voiceOver: NullableText,
  onScreenText: NullableText,
  primaryText: z.string(),
  shots: z.array(ShotSchema),
});
export type StoryboardRow = z.infer<typeof StoryboardRowSchema>;

export interface StoryboardChapter {
  id: string;
  title: string;
  summary: string | null;
  startFrame: number;
  durationInFrames: number;
  rows: StoryboardRow[];
}

/** A chapter without its rows (what the page always renders). */
export type StoryboardChapterHeader = Omit<StoryboardChapter, 'rows'> & { sceneCount: number };

/** One page of a chapter's rows, as returned by the storyboard route handler. */
export const StoryboardPageSchema = z.object({
  chapterId: z.string().min(1),
  offset: z.number().int().min(0),
  total: z.number().int().min(0),
  rows: z.array(StoryboardRowSchema),
});
export type StoryboardPage = z.infer<typeof StoryboardPageSchema>;

/** Cards rendered server-side on first load, across the first chapters. */
export const STORYBOARD_INITIAL_SCENES = 60;
/** Chapters (at most) that start expanded. */
export const STORYBOARD_OPEN_CHAPTERS = 3;
/** Cards fetched per "load more" / chapter expansion. */
export const STORYBOARD_PAGE_SIZE = 60;
/** Upper bound accepted by the route handler. */
export const STORYBOARD_MAX_PAGE_SIZE = 200;

export function buildStoryboard(artifacts: DirectorArtifacts, timeline: Timeline): StoryboardChapter[] {
  const boardScenes = new Map(artifacts.storyboard.scenes.map((s) => [s.id, s]));
  const shots = new Map(artifacts.shotList.scenes.map((s) => [s.sceneId, s.shots]));
  const choices = new Map(artifacts.engineSelection.choices.map((c) => [c.sceneId, c]));
  const specs = new Map(artifacts.sceneSpecs.scenes.map((s) => [s.sceneId, s]));

  const rows: StoryboardRow[] = timeline.scenes.map((scene, index) => {
    const boardId = scene.storyboardSceneId ?? scene.id;
    const board = boardScenes.get(boardId) ?? boardScenes.get(scene.id) ?? artifacts.storyboard.scenes[index];
    const key = board?.id ?? boardId;
    const choice = choices.get(key) ?? choices.get(scene.id);
    const spec = specs.get(key) ?? specs.get(scene.id);
    const content = scene.content;
    const template = content.engine === 'motion2d' || content.engine === 'three' ? content.template : null;
    return {
      index,
      id: scene.id,
      title: scene.title,
      startFrame: scene.startFrame,
      durationInFrames: scene.durationInFrames,
      engine: content.engine,
      template,
      engineRationale: choice?.rationale ?? null,
      cameraPreset: spec?.cameraPreset ?? scene.camera?.preset ?? null,
      shotType: board?.shotType ?? null,
      mood: board?.mood ?? null,
      transitionIn: scene.transitionIn?.type ?? (index === 0 ? null : (board?.transitionIn ?? null)),
      visualDescription: board?.visualDescription ?? null,
      voiceOver: board?.voiceOver ?? scene.narration?.text ?? null,
      onScreenText: board?.onScreenText ?? null,
      primaryText: primaryTemplateText(content, scene.title),
      shots: shots.get(key) ?? shots.get(scene.id) ?? [],
    };
  });

  const rowsByChapter = new Map<string, StoryboardRow[]>();
  for (const row of rows) {
    const chapterId = timeline.scenes[row.index]?.chapterId;
    if (chapterId === undefined) continue;
    const list = rowsByChapter.get(chapterId);
    if (list) list.push(row);
    else rowsByChapter.set(chapterId, [row]);
  }
  const outlines = new Map(artifacts.script.chapters.map((c) => [c.id, c]));

  return timeline.chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    summary: chapter.summary ?? outlines.get(chapter.id)?.summary ?? null,
    startFrame: chapter.startFrame,
    durationInFrames: chapter.durationInFrames,
    rows: rowsByChapter.get(chapter.id) ?? [],
  }));
}

const storyboardMemo = new WeakMap<object, StoryboardChapter[]>();

/** `buildStoryboard` memoized per (immutable, cached) version object. */
export function storyboardFor(version: { artifacts: DirectorArtifacts; timeline: Timeline }): StoryboardChapter[] {
  const hit = storyboardMemo.get(version);
  if (hit) return hit;
  const chapters = buildStoryboard(version.artifacts, version.timeline);
  storyboardMemo.set(version, chapters);
  return chapters;
}

export interface PlannedChapter {
  header: StoryboardChapterHeader;
  /** Expanded on first render. */
  open: boolean;
  /** Rows rendered on first load (a prefix of the chapter's rows; empty for collapsed chapters). */
  initialRows: StoryboardRow[];
}

export function chapterHeader(chapter: StoryboardChapter): StoryboardChapterHeader {
  const { rows, ...rest } = chapter;
  return { ...rest, sceneCount: rows.length };
}

/**
 * Which chapters start expanded and which cards render on first load: the first `openChapters` chapters are
 * expanded while the `sceneBudget` lasts (the first one always), and only a prefix of their rows is rendered.
 */
export function planStoryboard(
  chapters: readonly StoryboardChapter[],
  opts: { sceneBudget?: number; openChapters?: number } = {},
): PlannedChapter[] {
  let budget = Math.max(1, opts.sceneBudget ?? STORYBOARD_INITIAL_SCENES);
  const openChapters = Math.max(1, opts.openChapters ?? STORYBOARD_OPEN_CHAPTERS);
  return chapters.map((chapter, index) => {
    const open = index < openChapters && (index === 0 || budget > 0);
    const initialRows = open ? chapter.rows.slice(0, budget) : [];
    budget = Math.max(0, budget - initialRows.length);
    return { header: chapterHeader(chapter), open, initialRows };
  });
}

/** Rows `[offset, offset + limit)` of one chapter, or `null` when the chapter does not exist. */
export function pageChapterRows(
  chapters: readonly StoryboardChapter[],
  chapterId: string,
  offset: number,
  limit: number,
): StoryboardPage | null {
  const chapter = chapters.find((c) => c.id === chapterId);
  if (!chapter) return null;
  const start = Math.max(0, Math.trunc(offset));
  const size = Math.max(1, Math.min(STORYBOARD_MAX_PAGE_SIZE, Math.trunc(limit)));
  return { chapterId, offset: start, total: chapter.rows.length, rows: chapter.rows.slice(start, start + size) };
}
