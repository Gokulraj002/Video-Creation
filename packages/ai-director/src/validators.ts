import {
  getTemplate,
  validateTemplateProps,
  type ChapterEngineSelection,
  type ChapterScript,
  type ChapterShotList,
  type ChapterStoryboard,
  type EngineChoice,
  type ScriptOutline,
  type StoryboardScene,
} from '@vc/schema';
import type { ChapterSceneSpecsLlm } from './stages';

/** Semantic validators: return `path: message` issues (empty = valid). Zod validation runs first. */

export const OUTLINE_DURATION_TOLERANCE = 0.02;
export const SCRIPT_DURATION_TOLERANCE = 0.1;

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export function validateOutline(outline: ScriptOutline, expected: { chapterCount: number; totalSeconds: number }): string[] {
  const issues: string[] = [];
  if (outline.chapters.length !== expected.chapterCount) {
    issues.push(`chapters: expected exactly ${expected.chapterCount} chapters, got ${outline.chapters.length}`);
  }
  for (const id of duplicates(outline.chapters.map((c) => c.id))) {
    issues.push(`chapters: duplicate chapter id "${id}" (ids must be unique)`);
  }
  const sum = outline.chapters.reduce((a, c) => a + c.targetDurationSeconds, 0);
  if (Math.abs(sum - expected.totalSeconds) > expected.totalSeconds * OUTLINE_DURATION_TOLERANCE) {
    issues.push(
      `chapters: targetDurationSeconds must sum to ${fmt(expected.totalSeconds)} (±${OUTLINE_DURATION_TOLERANCE * 100}%), got ${fmt(sum)}`,
    );
  }
  return issues;
}

export function validateChapterScript(
  script: ChapterScript,
  expected: { targetDurationSeconds: number; maxSegments: number },
): string[] {
  const issues: string[] = [];
  for (const id of duplicates(script.segments.map((s) => s.id))) {
    issues.push(`segments: duplicate segment id "${id}" (ids must be unique)`);
  }
  if (script.segments.length > expected.maxSegments) {
    issues.push(`segments: at most ${expected.maxSegments} segments allowed for this chapter, got ${script.segments.length}`);
  }
  const sum = script.segments.reduce((a, s) => a + s.targetDurationSeconds, 0);
  const target = expected.targetDurationSeconds;
  if (Math.abs(sum - target) > target * SCRIPT_DURATION_TOLERANCE) {
    issues.push(
      `segments: targetDurationSeconds must sum to ${fmt(target)} (±${SCRIPT_DURATION_TOLERANCE * 100}%), got ${fmt(sum)}`,
    );
  }
  return issues;
}

export function validateChapterStoryboard(
  storyboard: ChapterStoryboard,
  expected: { sceneRange: { min: number; max: number }; segmentIds: readonly string[] },
): string[] {
  const issues: string[] = [];
  const { min, max } = expected.sceneRange;
  const n = storyboard.scenes.length;
  if (n < min || n > max) {
    issues.push(
      min === max
        ? `scenes: expected exactly ${min} scene${min === 1 ? '' : 's'}, got ${n}`
        : `scenes: expected between ${min} and ${max} scenes, got ${n}`,
    );
  }
  for (const id of duplicates(storyboard.scenes.map((s) => s.id))) {
    issues.push(`scenes: duplicate scene id "${id}" (ids must be unique)`);
  }
  const known = new Set(expected.segmentIds);
  storyboard.scenes.forEach((scene, i) => {
    if (scene.segmentIds.length === 0) {
      issues.push(`scenes.${i}.segmentIds: every scene must reference at least one script segment id`);
    }
    for (const segmentId of scene.segmentIds) {
      if (!known.has(segmentId)) {
        issues.push(`scenes.${i}.segmentIds: unknown segment id "${segmentId}" (valid: ${[...known].slice(0, 40).join(', ')})`);
      }
    }
    if (!(scene.durationSeconds > 0)) issues.push(`scenes.${i}.durationSeconds: must be > 0`);
  });
  return issues;
}

function checkOnePerScene(
  ids: readonly string[],
  scenes: readonly Pick<StoryboardScene, 'id'>[],
  path: string,
  label: string,
): string[] {
  const issues: string[] = [];
  const expected = new Set(scenes.map((s) => s.id));
  for (const id of duplicates(ids)) issues.push(`${path}: duplicate ${label} for scene "${id}"`);
  for (const id of ids) {
    if (!expected.has(id)) issues.push(`${path}: unknown sceneId "${id}"`);
  }
  const present = new Set(ids);
  for (const s of scenes) {
    if (!present.has(s.id)) issues.push(`${path}: missing ${label} for scene "${s.id}"`);
  }
  return issues;
}

export function validateChapterShotList(shotList: ChapterShotList, scenes: readonly StoryboardScene[]): string[] {
  return checkOnePerScene(
    shotList.scenes.map((s) => s.sceneId),
    scenes,
    'scenes',
    'shot list entry',
  );
}

export function validateChapterEngineSelection(selection: ChapterEngineSelection, scenes: readonly StoryboardScene[]): string[] {
  const issues = checkOnePerScene(
    selection.choices.map((c) => c.sceneId),
    scenes,
    'choices',
    'engine choice',
  );
  selection.choices.forEach((choice, i) => {
    if (choice.engine === 'motion2d' || choice.engine === 'three') {
      if (choice.template === null) {
        issues.push(`choices.${i}.template: a "${choice.engine}" scene needs a template id from the catalog`);
        return;
      }
      const t = getTemplate(choice.template);
      if (!t) {
        issues.push(`choices.${i}.template: unknown template "${choice.template}"`);
      } else if (t.engine !== choice.engine) {
        issues.push(`choices.${i}.template: template "${t.id}" is a "${t.engine}" template, not "${choice.engine}"`);
      }
    } else if (choice.template !== null) {
      issues.push(`choices.${i}.template: must be null for engine "${choice.engine}"`);
    }
  });
  return issues;
}

export function validateChapterSceneSpecs(specs: ChapterSceneSpecsLlm, choices: readonly EngineChoice[]): string[] {
  const issues = checkOnePerScene(
    specs.scenes.map((s) => s.sceneId),
    choices.map((c) => ({ id: c.sceneId })),
    'scenes',
    'scene spec',
  );
  const bySceneId = new Map(choices.map((c) => [c.sceneId, c]));
  specs.scenes.forEach((spec, i) => {
    const choice = bySceneId.get(spec.sceneId);
    if (!choice) return;
    if (spec.template !== choice.template) {
      issues.push(`scenes.${i}.template: must be "${choice.template ?? 'null'}" (the selected template), got "${spec.template}"`);
    }
    if (spec.engine !== choice.engine) {
      issues.push(`scenes.${i}.engine: must be "${choice.engine}", got "${spec.engine}"`);
    }
    const props = validateTemplateProps(spec.template, spec.props);
    if (!props.success) {
      for (const issue of props.issues) issues.push(`scenes.${i}.props.${issue}`);
    }
  });
  return issues;
}
