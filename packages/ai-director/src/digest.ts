import { resolveDimensions, type ReferenceProfile, type VideoRequest } from '@vc/schema';
import type { StructurePlan } from './planning';
import type { PlanDigest, ReferenceDigest, RequestDigest } from './stages';
import { uniqueHexColors } from './util/color';
import { clip } from './util/text';

/** Serializable request view used in stage inputs and prompts. */
export function digestRequest(request: VideoRequest): RequestDigest {
  const { width, height } = resolveDimensions(request);
  const brand = request.brand;
  return {
    title: request.title,
    prompt: request.prompt,
    genre: request.genre,
    styleNotes: request.styleNotes ?? null,
    durationSeconds: request.durationSeconds,
    aspectRatio: request.aspectRatio,
    width,
    height,
    fps: request.fps,
    language: request.language,
    brand: brand
      ? {
          name: brand.name ?? null,
          colors: uniqueHexColors(brand.colors),
          fontHeading: brand.fontHeading ?? null,
          fontBody: brand.fontBody ?? null,
          hasLogo: brand.logoAssetId !== undefined,
        }
      : null,
    voiceOver: {
      enabled: request.voiceOver.enabled,
      style: request.voiceOver.style ?? null,
      gender: request.voiceOver.gender ?? null,
    },
    music: { enabled: request.music.enabled, mood: request.music.mood ?? null },
  };
}

function topCounts(values: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([v]) => v);
}

/** Compact, prompt-friendly view of a reference profile (M3 analysis output). */
export function digestReference(ref: ReferenceProfile): ReferenceDigest {
  const transitions = [...ref.transitions].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)).filter((t) => t.count > 0);
  const transcript = ref.transcript?.segments.map((s) => s.text).join(' ') ?? '';
  return {
    id: ref.id,
    kind: ref.kind,
    durationSeconds: ref.metadata.durationSeconds ?? null,
    sceneCount: ref.scenes.length,
    averageShotSeconds: ref.pacing?.averageShotSeconds ?? null,
    cutsPerMinute: ref.pacing?.cutsPerMinute ?? null,
    palette: uniqueHexColors([...ref.palette].sort((a, b) => b.weight - a.weight).map((p) => p.hex)).slice(0, 8),
    moodTags: ref.moodTags.slice(0, 10),
    styleSummary: ref.styleSummary ? clip(ref.styleSummary, 1000) : null,
    transitions: transitions.slice(0, 4).map((t) => t.type),
    shotTypes: topCounts(
      ref.scenes.flatMap((s) => (s.shotType ? [s.shotType] : [])),
      4,
    ),
    cameraMovements: topCounts(
      ref.scenes.flatMap((s) => (s.cameraMovement ? [s.cameraMovement] : [])),
      4,
    ),
    fonts: ref.typography?.fontsDetected.slice(0, 5) ?? [],
    hasMusic: ref.audio?.hasMusic ?? null,
    hasVoice: ref.audio?.hasVoice ?? null,
    tempoBpm: ref.audio?.tempoBpm ?? null,
    transcriptExcerpt: transcript.length > 0 ? clip(transcript, 600) : null,
  };
}

export function digestPlan(plan: StructurePlan): PlanDigest {
  return {
    totalSeconds: plan.durationSeconds,
    chapterCount: plan.chapterCount,
    chapterTargetSeconds: [...plan.chapterTargetSeconds],
    targetSceneSeconds: plan.targetSceneSeconds,
    sceneCountRange: { ...plan.sceneCountRange },
    perChapterSceneRange: plan.perChapterSceneRange.map((r) => ({ ...r })),
  };
}
