import type {
  DirectorArtifacts,
  EngineType,
  Shot,
  ShotType,
  Timeline,
  TransitionType,
} from '@vc/schema';
import { primaryTemplateText } from './animatic';

/**
 * Joins director artifacts (storyboard, shot list, engine selection, scene specs) with the compiled timeline so
 * the UI can show one card per scene with exact frames. Pure (unit-tested).
 */

export interface StoryboardRow {
  index: number;
  id: string;
  title: string;
  startFrame: number;
  durationInFrames: number;
  engine: EngineType;
  template: string | null;
  engineRationale: string | null;
  cameraPreset: string | null;
  shotType: ShotType | null;
  mood: string | null;
  transitionIn: TransitionType | null;
  visualDescription: string | null;
  voiceOver: string | null;
  onScreenText: string | null;
  primaryText: string;
  shots: Shot[];
}

export interface StoryboardChapter {
  id: string;
  title: string;
  summary: string | null;
  startFrame: number;
  durationInFrames: number;
  rows: StoryboardRow[];
}

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

  return timeline.chapters.map((chapter) => {
    const outline = artifacts.script.chapters.find((c) => c.id === chapter.id);
    return {
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary ?? outline?.summary ?? null,
      startFrame: chapter.startFrame,
      durationInFrames: chapter.durationInFrames,
      rows: rows.filter((row) => timeline.scenes[row.index]?.chapterId === chapter.id),
    };
  });
}
