import type {
  ChapterScript,
  ChapterShotList,
  ChapterStoryboard,
  CreativeBrief,
  ScriptOutline,
  ScriptSegment,
  Shot,
  ShotType,
  StoryboardScene,
  TransitionType,
} from '@vc/schema';
import { cycle, genreProfile, type GenreProfile } from '../../genres';
import type {
  BriefStageInput,
  OutlineStageInput,
  ReferenceDigest,
  ScriptStageInput,
  ShotListStageInput,
  StoryboardStageInput,
} from '../../stages';
import { uniqueHexColors } from '../../util/color';
import { clip, clipOr, round, sentences, words } from '../../util/text';
import { analyzeRequest, beatVisual, comicLine, displayTitle, fnv1a, narration, Rng, shortLine, type TopicAnalysis } from './content';

type NonEmpty<T> = readonly [T, ...T[]];

function nonEmptyOr<T>(items: readonly T[], fallback: NonEmpty<T>): NonEmpty<T> {
  const [first, ...rest] = items;
  return first === undefined ? fallback : [first, ...rest];
}

/** Splits `total` into `weights`-proportional parts rounded to ms that sum exactly to `total` (last absorbs error). */
function splitSeconds(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let acc = 0;
  weights.forEach((w, i) => {
    if (i === weights.length - 1) {
      out.push(Math.max(0.001, round(total - acc, 6)));
    } else {
      const part = Math.max(0.001, round((total * w) / sum, 3));
      out.push(part);
      acc += part;
    }
  });
  return out;
}

function referenceShotTypes(refs: readonly ReferenceDigest[]): ShotType[] {
  const valid = new Set<string>(['establishing', 'wide', 'medium', 'close-up', 'extreme-close-up', 'over-the-shoulder', 'pov', 'overhead', 'macro', 'insert', 'two-shot']);
  return refs.flatMap((r) => r.shotTypes).filter((s): s is ShotType => valid.has(s));
}

function referenceTransitions(refs: readonly ReferenceDigest[]): TransitionType[] {
  const valid = new Set<string>(['cut', 'fade', 'crossfade', 'slide', 'wipe', 'zoom', 'blur', 'dip-to-black', 'dip-to-white']);
  return refs.flatMap((r) => r.transitions).filter((t): t is TransitionType => valid.has(t));
}

// =============================================================================================
// Brief
// =============================================================================================

export function mockBrief(input: BriefStageInput): CreativeBrief {
  const { request } = input;
  const p = genreProfile(request.genre);
  const topic = analyzeRequest(request, p);
  const refPalette = request.genre === 'reference-based' ? input.references.flatMap((r) => r.palette) : [];
  const palette = uniqueHexColors([...(request.brand?.colors ?? []), ...refPalette, ...p.palette]).slice(0, 8);
  const refMoods = input.references.flatMap((r) => r.moodTags).map((m) => clip(m, 60));
  const tone = [...p.tone, ...refMoods].filter((t, i, a) => t.length > 0 && a.indexOf(t) === i).slice(0, 6);
  const brand = request.brand;
  const brandNotes = brand
    ? clip(
        [
          `Use ${brand.name ?? 'the brand'} consistently`,
          brand.colors.length > 0 ? `lead with the brand colors ${brand.colors.join(', ')}` : '',
          brand.fontHeading || brand.fontBody ? `typography ${[brand.fontHeading, brand.fontBody].filter(Boolean).join(' / ')}` : '',
          brand.hasLogo ? 'show the logo on the opening and closing scenes' : '',
        ]
          .filter((s) => s.length > 0)
          .join('; ') + '.',
        1000,
      )
    : '';
  const references = input.references;
  const referenceInfluence =
    references.length > 0
      ? clip(
          references
            .map(
              (r) =>
                `Reference ${r.id}: ${r.styleSummary ?? 'style reference'}` +
                (r.averageShotSeconds ? `; average shot ${round(r.averageShotSeconds, 1)} s` : '') +
                (r.transitions.length > 0 ? `; favours ${r.transitions.slice(0, 2).join(' and ')} transitions` : '') +
                (r.moodTags.length > 0 ? `; mood ${r.moodTags.slice(0, 3).join(', ')}` : ''),
            )
            .join('. '),
          1000,
        )
      : null;
  return {
    title: displayTitle(request.title),
    logline: clip(topic.messages[0], 300),
    objective: clip(p.objective.replace('{title}', displayTitle(request.title)), 1000),
    targetAudience: clip(p.audience, 500),
    tone: tone.length > 0 ? tone : [...p.tone],
    genre: request.genre,
    visualStyle: {
      description: clip(`${p.visualDescription}${request.styleNotes ? ` Style notes: ${request.styleNotes}` : ''}`, 1000),
      palette: palette.length >= 2 ? palette : [...p.palette],
      typography: clip(
        brand?.fontHeading ? `${brand.fontHeading} headlines; ${p.typography}` : p.typography,
        300,
      ),
      motionLanguage: clip(p.motionLanguage, 500),
    },
    keyMessages: topic.messages.slice(0, 6),
    callToAction: topic.callToAction ?? p.defaultCallToAction,
    referenceInfluence,
    brandConsistencyNotes: brandNotes,
  };
}

// =============================================================================================
// Outline
// =============================================================================================

function chapterTitle(p: GenreProfile, topic: TopicAnalysis, index: number, count: number, briefTitle: string): string {
  if (count === 1) return clip(briefTitle, 200);
  const themes = p.chapterThemes;
  if (count <= themes.length) {
    const t = themes[Math.round((index * (themes.length - 1)) / Math.max(1, count - 1))] ?? themes[0];
    return clip(t, 200);
  }
  if (index === 0) return themes[0];
  if (index === count - 1) return themes[themes.length - 1] ?? themes[0];
  const message = cycle(topic.messages, index - 1);
  return clip(`Part ${index + 1}: ${shortLine(message, 7)}`, 200);
}

export function mockOutline(input: OutlineStageInput): ScriptOutline {
  const p = genreProfile(input.request.genre);
  const topic = analyzeRequest(input.request, p);
  const n = input.plan.chapterCount;
  const cta = input.brief.callToAction;
  return {
    chapters: Array.from({ length: n }, (_, i) => {
      const message = cycle(nonEmptyOr(input.brief.keyMessages, topic.messages), i);
      const summary =
        i === 0
          ? `Opens with a strong hook and introduces ${input.brief.title}. ${message}`
          : i === n - 1
            ? `Brings the story home${cta ? ` and closes with the call to action: ${cta}` : ''}. ${message}`
            : `Develops the story of ${input.brief.title}. ${message}`;
      return {
        id: `c${i + 1}`,
        title: chapterTitle(p, topic, i, n, input.brief.title),
        summary: clip(summary, 2000),
        targetDurationSeconds: input.plan.chapterTargetSeconds[i] ?? input.plan.totalSeconds / n,
      };
    }),
  };
}

// =============================================================================================
// Script
// =============================================================================================

function beatFor(p: GenreProfile, isOpening: boolean, isClosing: boolean, index: number): string {
  if (isOpening) return p.genre === 'comedy' ? 'setup' : p.genre === 'cartoon' ? 'introduction' : 'opening';
  if (isClosing) return p.genre === 'comedy' ? 'punchline' : p.genre === 'cartoon' ? 'resolution' : 'closing';
  return cycle(p.beats, index);
}

export function mockChapterScript(input: ScriptStageInput): ChapterScript {
  const { request, chapter, brief } = input;
  const p = genreProfile(request.genre);
  const topic = analyzeRequest(request, p);
  const rng = new Rng(fnv1a(`script|${request.title}|${chapter.id}|${chapter.targetDurationSeconds}`));
  const maxCount = Math.max(1, Math.min(chapter.sceneRange.max, input.maxSegments));
  const count = Math.min(maxCount, Math.max(chapter.sceneRange.min, Math.round(chapter.targetDurationSeconds / input.targetSceneSeconds), 1));
  const weights = Array.from({ length: count }, () => rng.range(0.85, 1.15));
  const durations = splitSeconds(chapter.targetDurationSeconds, weights);
  const messages = nonEmptyOr(brief.keyMessages, topic.messages);
  const offset = chapter.index * count;

  const segments: ScriptSegment[] = durations.map((duration, k) => {
    const isOpening = chapter.isFirst && k === 0;
    const isClosing = chapter.isLast && k === count - 1 && !isOpening;
    const index = offset + k;
    const beat = beatFor(p, isOpening, isClosing, index);
    // SOP: sequential steps after the opening; extra segments double-check earlier steps.
    const stepIndex = Math.max(0, index - (chapter.isFirst ? 1 : 0));
    const ctx: LeadContext = { p, topic, brief, beat, index, stepIndex, isOpening, isClosing };
    const lead = segmentLead(ctx);
    const support = [...messages.slice(index % messages.length), ...messages];
    const voiceOver = request.voiceOver.enabled
      ? narration({ beat, title: brief.title, lead, support, targetWords: duration * p.wordsPerSecond })
      : null;
    return {
      id: `g${k + 1}`,
      voiceOver,
      onScreenText: onScreenFor(ctx, lead),
      visualIntent: clip(`${beatVisual(beat)}. ${p.visualDescription.split('.')[0] ?? ''}.`, 1000),
      targetDurationSeconds: duration,
    };
  });
  return { chapterId: chapter.id, segments };
}

interface LeadContext {
  p: GenreProfile;
  topic: TopicAnalysis;
  brief: CreativeBrief;
  beat: string;
  index: number;
  stepIndex: number;
  isOpening: boolean;
  isClosing: boolean;
}

const CLOSING_LINES: Partial<Record<GenreProfile['genre'], (title: string) => { lead: string; onScreen: string }>> = {
  'sop-training': (t) => ({ lead: `That completes the ${t} procedure. Follow every step in order, every time`, onScreen: `Recap: ${t}` }),
  'corporate-training': (t) => ({ lead: `Those are the key takeaways from ${t}. Put them into practice this week`, onScreen: 'Key takeaways' }),
  presentation: () => ({ lead: 'Here are the recommended next steps', onScreen: 'Next steps' }),
  'long-form': (t) => ({ lead: `And that is the story of ${t}`, onScreen: 'Final thoughts' }),
  cartoon: () => ({ lead: 'And they all lived happily ever after', onScreen: 'The End' }),
};

function sopStep(ctx: LeadContext): { text: string; isRepeat: boolean } {
  const { steps } = ctx.topic;
  const step = cycle(steps, ctx.stepIndex);
  return { text: step, isRepeat: ctx.stepIndex >= steps.length };
}

function segmentLead(ctx: LeadContext): string {
  const { p, topic, brief, index } = ctx;
  const messages = nonEmptyOr(brief.keyMessages, topic.messages);
  if (ctx.isOpening) return messages[0];
  if (ctx.isClosing) {
    if (brief.callToAction) return brief.callToAction;
    return CLOSING_LINES[p.genre]?.(brief.title).lead ?? cycle(messages, index);
  }
  if (p.genre === 'sop-training') {
    const step = sopStep(ctx);
    return step.isRepeat ? `Double-check: ${step.text}` : step.text;
  }
  if (p.genre === 'real-estate' && topic.features.length > 0) {
    const [first, ...rest] = topic.features;
    if (first !== undefined) return `${cycle([first, ...rest], index)}. ${cycle(messages, index)}`;
  }
  return cycle(messages, index);
}

function onScreenFor(ctx: LeadContext, lead: string): string | null {
  const { p, topic, brief, beat, index } = ctx;
  if (ctx.isOpening) return clip(brief.title, 120);
  if (ctx.isClosing) {
    if (brief.callToAction) return shortLine(brief.callToAction, 8);
    const closing = CLOSING_LINES[p.genre]?.(brief.title).onScreen;
    if (closing) return clip(closing, 120);
  }
  if (p.genre === 'comedy' || p.genre === 'cartoon') return comicLine(beat, brief.title, index) ?? shortLine(lead, 8);
  if (p.genre === 'sop-training') return shortLine(sopStep(ctx).text, 8);
  if (p.genre === 'real-estate') {
    // One feature per scene in prompt order; once they are used up, fall through instead of repeating.
    const feature = topic.features[index - 1];
    if (feature !== undefined) return clip(feature, 120);
  }
  if (beat === 'data' || beat === 'proof') {
    const fact = topic.numericFacts[index % Math.max(1, topic.numericFacts.length)];
    if (fact) return shortLine(fact, 8);
  }
  return shortLine(lead, 8);
}

// =============================================================================================
// Storyboard
// =============================================================================================

interface Piece {
  segmentIds: string[];
  voiceOver: string | null;
  onScreenText: string | null;
  visualIntent: string;
  duration: number;
  part: number;
}

function splitPiece(piece: Piece): [Piece, Piece] {
  const vo = piece.voiceOver ? words(piece.voiceOver) : [];
  const half = Math.ceil(vo.length / 2);
  const firstVo = vo.slice(0, half).join(' ');
  const secondVo = vo.slice(half).join(' ');
  const d1 = round(piece.duration / 2, 3);
  return [
    { ...piece, voiceOver: piece.voiceOver ? firstVo || null : null, duration: d1 },
    { ...piece, voiceOver: piece.voiceOver ? secondVo || null : null, duration: round(piece.duration - d1, 6), part: piece.part + 1 },
  ];
}

function mergePieces(a: Piece, b: Piece): Piece {
  const vo = [a.voiceOver, b.voiceOver].filter((v): v is string => v !== null && v.length > 0).join(' ');
  return {
    segmentIds: [...a.segmentIds, ...b.segmentIds.filter((id) => !a.segmentIds.includes(id))],
    voiceOver: vo.length > 0 ? clip(vo, 5000) : null,
    onScreenText: a.onScreenText ?? b.onScreenText,
    visualIntent: a.visualIntent,
    duration: round(a.duration + b.duration, 6),
    part: a.part,
  };
}

/** Adjusts the pieces to `[min, max]` by splitting the longest / merging the shortest adjacent pair. */
function fitPieces(pieces: Piece[], min: number, max: number): Piece[] {
  const out = [...pieces];
  while (out.length < min) {
    let longest = 0;
    out.forEach((pc, i) => {
      if (pc.duration > (out[longest]?.duration ?? 0)) longest = i;
    });
    const target = out[longest];
    if (!target) break;
    out.splice(longest, 1, ...splitPiece(target));
  }
  while (out.length > max && out.length > 1) {
    let best = 0;
    let bestDuration = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i++) {
      const d = (out[i]?.duration ?? 0) + (out[i + 1]?.duration ?? 0);
      if (d < bestDuration) {
        bestDuration = d;
        best = i;
      }
    }
    const a = out[best];
    const b = out[best + 1];
    if (!a || !b) break;
    out.splice(best, 2, mergePieces(a, b));
  }
  return out;
}

export function mockChapterStoryboard(input: StoryboardStageInput): ChapterStoryboard {
  const { request, chapter } = input;
  const p = genreProfile(request.genre);
  const shotTypes = nonEmptyOr(referenceShotTypes(input.references), p.shotTypes);
  const transitions = nonEmptyOr(referenceTransitions(input.references), p.transitions);

  if (input.regenerate) {
    return { chapterId: chapter.id, scenes: [regenerateScene(input, p, shotTypes, transitions)] };
  }

  const pieces = fitPieces(
    input.script.segments.map((s) => ({
      segmentIds: [s.id],
      voiceOver: s.voiceOver,
      onScreenText: s.onScreenText,
      visualIntent: s.visualIntent,
      duration: s.targetDurationSeconds,
      part: 1,
    })),
    chapter.sceneRange.min,
    chapter.sceneRange.max,
  );

  const scenes: StoryboardScene[] = pieces.map((piece, m) => {
    const g = input.firstSceneIndex + m;
    const shotType = cycle(shotTypes, g);
    const base = piece.onScreenText ?? shortLine(piece.visualIntent, 8);
    return {
      id: `s${m + 1}`,
      chapterId: chapter.id,
      segmentIds: piece.segmentIds,
      title: clip(piece.part > 1 ? `${base} (continued)` : base, 200),
      visualDescription: clip(`${piece.visualIntent} ${capitalizeShot(shotType)} framing; ${p.motionLanguage.toLowerCase()}.`, 2000),
      voiceOver: piece.voiceOver,
      onScreenText: piece.onScreenText,
      durationSeconds: Math.max(0.001, round(piece.duration, 6)),
      mood: cycle(p.moods, g),
      shotType,
      transitionIn: g === 0 ? 'cut' : cycle(transitions, g),
    };
  });
  return { chapterId: chapter.id, scenes };
}

function capitalizeShot(shot: ShotType): string {
  return shot.charAt(0).toUpperCase() + shot.slice(1).replace(/-/g, ' ');
}

function regenerateScene(
  input: StoryboardStageInput,
  p: GenreProfile,
  shotTypes: NonEmpty<ShotType>,
  transitions: NonEmpty<TransitionType>,
): StoryboardScene {
  const r = input.regenerate;
  if (!r) throw new Error('regenerate context missing');
  const current = r.current;
  const known = new Set(input.script.segments.map((s) => s.id));
  const segmentIds = current.segmentIds.filter((id) => known.has(id));
  const firstSegment = input.script.segments[0];
  const variant = fnv1a(`${current.id}|${current.title}|${current.mood}|${current.shotType}|${r.instructions ?? ''}`);
  const nextDifferent = <T>(items: NonEmpty<T>, currentValue: T): T => {
    const start = variant % items.length;
    for (let i = 0; i < items.length; i++) {
      const candidate = items[(start + i) % items.length] ?? items[0];
      if (candidate !== currentValue) return candidate;
    }
    return currentValue;
  };
  const quoted = r.instructions ? /["“]([^"”]{2,120})["”]/.exec(r.instructions)?.[1] ?? null : null;
  const onScreenText = quoted ?? current.onScreenText;
  const instructionNote = r.instructions ? ` Direction: ${clip(r.instructions, 300)}.` : '';
  const shotType = nextDifferent(shotTypes, current.shotType);
  return {
    id: current.id,
    chapterId: input.chapter.id,
    segmentIds: segmentIds.length > 0 ? segmentIds : firstSegment ? [firstSegment.id] : current.segmentIds,
    title: clip(quoted ?? `${current.title.replace(/\s+—\s+new take$/, '')} — new take`, 200),
    visualDescription: clip(
      `Fresh take: ${beatVisual(cycle(p.beats, variant)).toLowerCase()}, ${capitalizeShot(shotType).toLowerCase()} framing.${instructionNote} ${current.visualDescription}`,
      2000,
    ),
    voiceOver: current.voiceOver,
    onScreenText,
    durationSeconds: r.durationSeconds,
    mood: nextDifferent(p.moods, current.mood),
    shotType,
    transitionIn: r.globalIndex === 0 ? 'cut' : nextDifferent(transitions, current.transitionIn),
  };
}

// =============================================================================================
// Shot list
// =============================================================================================

export function mockChapterShotList(input: ShotListStageInput): ChapterShotList {
  const p = genreProfile(input.request.genre);
  const shotTypes = nonEmptyOr(referenceShotTypes(input.references), p.shotTypes);
  return {
    chapterId: input.chapter.id,
    scenes: input.scenes.map((scene, i) => {
      const n = scene.durationSeconds < 3 ? 1 : Math.min(4, Math.max(1, Math.round(scene.durationSeconds / 4)));
      const seed = fnv1a(`${scene.id}|${scene.title}`);
      const durations = splitSeconds(scene.durationSeconds, new Array<number>(n).fill(1));
      const subjectBase = sentences(scene.visualDescription)[0] ?? scene.title;
      const shots: Shot[] = durations.map((d, j) => ({
        id: `sh${j + 1}`,
        shotType: j === 0 ? scene.shotType : cycle(shotTypes, seed + j),
        cameraMovement: cycle(p.cameraMovements, seed + i + j),
        subject: clipOr(j === 0 ? subjectBase : `${scene.title} — detail ${j + 1}`, scene.title, 500),
        durationSeconds: d,
        notes: j === 0 ? clip(`${p.motionLanguage}. Mood: ${scene.mood}.`, 1000) : null,
      }));
      return { sceneId: scene.id, shots };
    }),
  };
}
