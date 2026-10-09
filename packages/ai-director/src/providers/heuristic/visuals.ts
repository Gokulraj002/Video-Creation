import {
  getTemplate,
  type CameraPreset,
  type CatalogTemplateId,
  type ChapterEngineSelection,
  type EngineChoice,
} from '@vc/schema';
import { cameraPresetForMovement } from '../../camera-mapping';
import { InternalDirectorError } from '../../errors';
import { cycle, genreProfile, type GenreProfile } from '../../genres';
import type { ChapterSceneSpecsLlm, EngineSelectionStageInput, SceneSpecsSceneInput, SceneSpecsStageInput } from '../../stages';
import { clip, clipOr, clipOrNull, round, sentences } from '../../util/text';
import {
  analyzeRequest,
  fnv1a,
  isBeatOpener,
  shortLine,
  type CartoonCharacter,
  type CartoonSetting,
  type TopicAnalysis,
} from './content';

// =============================================================================================
// Engine selection
// =============================================================================================

const QUOTE_HINT = /["“”]/;
const NUMBER_HINT = /\d/;
const RECAP_HINT = /\b(recap|summary|checklist|review|overview|agenda|takeaways?)\b/i;

function isAvailable(input: EngineSelectionStageInput, engine: 'motion2d' | 'three'): boolean {
  return input.engines.some((e) => e.engine === engine && e.available);
}

function usable(input: EngineSelectionStageInput, id: CatalogTemplateId): boolean {
  const t = getTemplate(id);
  return t !== undefined && isAvailable(input, t.engine);
}

function bodyCandidates(p: GenreProfile, input: EngineSelectionStageInput): CatalogTemplateId[] {
  const list = p.bodyTemplates.filter((id) => usable(input, id));
  return list.length > 0 ? list : [p.fallbackTemplate];
}

function chooseTemplate(
  p: GenreProfile,
  input: EngineSelectionStageInput,
  index: number,
  previous: CatalogTemplateId | null,
): { template: CatalogTemplateId; reason: string } {
  const pos = input.scenes[index];
  if (!pos) return { template: p.fallbackTemplate, reason: 'default' };
  const scene = pos.scene;
  const text = `${scene.title} ${scene.onScreenText ?? ''} ${scene.voiceOver ?? ''}`;
  const body = bodyCandidates(p, input);
  const hero = body[0] ?? p.fallbackTemplate;
  const pickUsable = (id: CatalogTemplateId): CatalogTemplateId => (usable(input, id) ? id : p.fallbackTemplate);
  const positional = (): { template: CatalogTemplateId; reason: string } | null => {
    if (input.totalScenes === 1) return { template: hero, reason: `single-scene ${p.label.toLowerCase()} uses the genre hero template` };
    if (pos.isFirstInVideo) return { template: pickUsable(p.openingTemplate), reason: 'opens the video' };
    if (pos.isLastInVideo) {
      return input.hasCallToAction
        ? { template: 'cta-end-card', reason: 'closes on the call to action' }
        : { template: pickUsable(p.closingTemplate), reason: 'closes the video' };
    }
    if (pos.isFirstInChapter && input.chapter.count > 1 && p.genre !== 'comedy' && p.genre !== 'cartoon' && p.genre !== 'social-short') {
      return { template: 'title-card', reason: 'chapter opener card' };
    }
    return null;
  };
  // Opening / closing / chapter-opener scenes keep their structural template (even when regenerated).
  const fixed = positional();
  if (fixed) return fixed;

  // Content-aware choices.
  if (p.genre === 'sop-training') {
    const t: CatalogTemplateId = RECAP_HINT.test(text) ? 'bullet-list' : 'step-instruction';
    // A procedure step stays a numbered step when regenerated (removing it would renumber every later step).
    if (t !== input.previousChoice?.template || t === 'step-instruction') return { template: t, reason: 'one procedure step per scene' };
  }
  if (p.genre === 'real-estate' && previous !== 'property-showcase' && (/[$€£₹]/.test(text) || /\b(bed|bath|sq|acre|pool|garden)\w*/i.test(text))) {
    if (input.previousChoice?.template !== 'property-showcase') return { template: 'property-showcase', reason: 'listing details' };
  }
  if (NUMBER_HINT.test(scene.onScreenText ?? '') && body.includes('stat-counter') && previous !== 'stat-counter') {
    if (input.previousChoice?.template !== 'stat-counter') return { template: 'stat-counter', reason: 'highlights a key number' };
  }
  if (QUOTE_HINT.test(text) && body.includes('quote') && previous !== 'quote') {
    if (input.previousChoice?.template !== 'quote') return { template: 'quote', reason: 'features a memorable line' };
  }

  // Rotate through the genre's body templates, avoiding back-to-back repeats (cartoon keeps its hero).
  const start = pos.globalIndex % body.length;
  for (let i = 0; i < body.length; i++) {
    const candidate = body[(start + i) % body.length] ?? hero;
    const repeatsPrevious = candidate === previous && body.length > 1;
    const repeatsOld = candidate === input.previousChoice?.template && body.length > 1;
    if (!repeatsPrevious && !repeatsOld) return { template: candidate, reason: `${p.label.toLowerCase()} body scene` };
  }
  return { template: hero, reason: `${p.label.toLowerCase()} hero template` };
}

export function mockChapterEngineSelection(input: EngineSelectionStageInput): ChapterEngineSelection {
  const p = genreProfile(input.request.genre);
  let previous: CatalogTemplateId | null = null;
  const choices: EngineChoice[] = input.scenes.map((pos, i) => {
    const { template, reason } = chooseTemplate(p, input, i, previous);
    previous = template;
    const def = getTemplate(template);
    if (!def) throw new InternalDirectorError(`Mock selected unknown template "${template}"`);
    return {
      sceneId: pos.scene.id,
      engine: def.engine,
      template: def.id,
      provider: null,
      rationale: clip(`${def.name}: ${reason} (${pos.scene.mood}).`, 500),
    };
  });
  return { chapterId: input.chapter.id, choices };
}

// =============================================================================================
// Scene specs
// =============================================================================================

type Props = Record<string, unknown>;

const EXPRESSIONS: Readonly<Record<string, 'happy' | 'surprised' | 'confused' | 'angry' | 'laughing'>> = {
  silly: 'laughing',
  awkward: 'confused',
  chaotic: 'surprised',
  gleeful: 'happy',
  deadpan: 'confused',
  cheerful: 'happy',
  curious: 'surprised',
  mischievous: 'laughing',
  surprised: 'surprised',
  joyful: 'happy',
};
const CHARACTERS: readonly [CartoonCharacter, ...CartoonCharacter[]] = ['blob', 'robot', 'cat', 'bird'];
const SETTINGS: readonly [CartoonSetting, ...CartoonSetting[]] = ['room', 'office', 'park', 'space', 'stage'];
const GAGS = ['bounce', 'shake', 'spin', 'squash'] as const;

function sceneText(s: SceneSpecsSceneInput): string | null {
  return s.scene.onScreenText ?? (s.scene.voiceOver ? sentences(s.scene.voiceOver)[0] ?? null : null);
}

function bulletsFor(s: SceneSpecsSceneInput, input: SceneSpecsStageInput, topic: TopicAnalysis): string[] {
  const fromVo = s.scene.voiceOver ? sentences(s.scene.voiceOver).filter((x) => x.split(/\s+/).length >= 3) : [];
  const pool = input.request.genre === 'sop-training' ? [...topic.steps] : [...fromVo, ...input.brief.keyMessages];
  return pool
    .map((b) => shortLine(b, 10))
    .filter((b, i, a) => b.length > 0 && a.indexOf(b) === i)
    .slice(0, 5);
}

function paletteColor(input: SceneSpecsStageInput, index: number): string {
  const palette = input.brief.visualStyle.palette;
  return palette[index % palette.length] ?? palette[0] ?? '#1E3A8A';
}

function buildPropsFor(
  s: SceneSpecsSceneInput,
  input: SceneSpecsStageInput,
  topic: TopicAnalysis,
  stepInfo: { stepNumber: number; totalSteps: number },
): Props {
  const template = s.choice.template;
  const def = template ? getTemplate(template) : undefined;
  if (!def) throw new InternalDirectorError(`Scene "${s.scene.id}" has no catalog template`);
  const brandName = input.request.brand?.name ?? null;
  const text = sceneText(s);
  const bullets = bulletsFor(s, input, topic);
  const ctx = {
    title: s.scene.title,
    text,
    bullets,
    palette: [...input.brief.visualStyle.palette],
    brandName,
  };
  const base: Props = { ...def.buildProps(ctx) };
  const g = s.globalIndex;

  switch (def.id) {
    case 'title-card': {
      const headline = s.isFirstInVideo ? input.brief.title : s.isFirstInChapter ? input.chapter.title : s.scene.title;
      const sub = s.isFirstInVideo ? input.brief.logline : s.isFirstInChapter ? input.chapter.summary : text;
      return { ...base, headline: clipOr(headline, 'Untitled', 120), subheadline: clipOrNull(sub, 200) };
    }
    case 'bullet-list':
      return { ...base, title: clipOr(s.scene.onScreenText ?? s.scene.title, 'Key points', 120) };
    case 'quote':
      return {
        ...base,
        quote: clipOr(s.scene.voiceOver ? sentences(s.scene.voiceOver).slice(0, 2).join(' ') : text, input.brief.logline, 400),
        attribution: clipOrNull(brandName ?? input.brief.title, 120),
      };
    case 'stat-counter': {
      const fact = topic.numericFacts[g % Math.max(1, topic.numericFacts.length)] ?? null;
      const withNumber = getTemplate('stat-counter')?.buildProps({ ...ctx, text: s.scene.onScreenText ?? fact ?? text });
      return { ...base, ...(withNumber ?? {}), label: clipOr(s.scene.title, 'Growth', 120) };
    }
    case 'step-instruction': {
      const caution = topic.cautions[stepInfo.stepNumber - 1] ?? (stepInfo.stepNumber === 1 ? 'Follow your site safety rules before you begin.' : null);
      const spoken = s.scene.voiceOver ? sentences(s.scene.voiceOver).filter((x) => !isBeatOpener(x)) : [];
      return {
        ...base,
        stepNumber: stepInfo.stepNumber,
        totalSteps: stepInfo.totalSteps,
        title: clipOr(s.scene.onScreenText ?? s.scene.title, `Step ${stepInfo.stepNumber}`, 120),
        instruction: clipOr(spoken.slice(0, 2).join(' ') || s.scene.title, s.scene.visualDescription, 500),
        caution: clipOrNull(caution, 200),
      };
    }
    case 'split-feature': {
      const asset = input.imageAssetIds.length > 0 ? input.imageAssetIds[g % input.imageAssetIds.length] ?? null : null;
      return {
        ...base,
        headline: clipOr(s.scene.onScreenText ?? s.scene.title, 'Feature', 120),
        body: clipOr(s.scene.voiceOver ?? s.scene.visualDescription, s.scene.title, 500),
        mediaSide: g % 2 === 0 ? 'right' : 'left',
        imageAssetId: asset,
        imagePrompt: clip(s.scene.visualDescription, 500),
      };
    }
    case 'cta-end-card':
      return {
        ...base,
        headline: clipOr(brandName ?? input.brief.title, 'Thank you', 120),
        callToAction: clipOr(input.brief.callToAction, 'Learn more', 120),
        contactLine: clipOrNull(topic.contact, 160),
      };
    case 'cartoon-scene': {
      const seed = fnv1a(input.request.title);
      const character = topic.character ?? CHARACTERS[seed % CHARACTERS.length] ?? 'blob';
      const setting = topic.setting ?? SETTINGS[fnv1a(`${input.request.title}|${input.chapter.id}`) % SETTINGS.length] ?? 'room';
      return {
        ...base,
        character,
        expression: EXPRESSIONS[s.scene.mood] ?? cycle(['happy', 'surprised', 'confused', 'laughing'], g),
        dialogue: clipOrNull(s.scene.onScreenText ?? text, 200),
        setting,
        gag: s.isFirstInVideo ? 'bounce' : cycle(GAGS, g),
        backgroundColor: paletteColor(input, g),
      };
    }
    case 'property-showcase': {
      const pool = topic.features.length > 0 ? topic.features : bullets.length > 0 ? bullets : [clip(s.scene.title, 120)];
      // Lead with a different feature in every listing card.
      const shift = g % pool.length;
      const features = [...pool.slice(shift), ...pool.slice(0, shift)].slice(0, 6);
      return {
        ...base,
        propertyName: clipOr(input.brief.title, 'Featured property', 120),
        location: clipOr(topic.location ?? brandName, 'Prime location', 160),
        price: topic.price,
        features: features.map((f) => clip(f, 120)),
      };
    }
    case 'lower-third':
      return {
        ...base,
        name: clipOr(s.scene.onScreenText ?? s.scene.title, 'Speaker', 80),
        role: clipOrNull(topic.location ?? brandName ?? input.chapter.title, 120),
      };
    case 'product-turntable': {
      const product = getTemplate('product-turntable')?.buildProps({ ...ctx, title: `${input.request.title} ${s.scene.title}`, text: input.request.prompt });
      return {
        ...base,
        ...(product ?? {}),
        color: paletteColor(input, g),
        metalness: round(0.25 + (fnv1a(s.scene.id) % 50) / 100, 2),
        roughness: round(0.2 + (fnv1a(`${s.scene.id}|r`) % 40) / 100, 2),
        headline: clipOrNull(s.scene.onScreenText ?? input.brief.title, 120),
        rotationTurns: Math.min(4, Math.max(0.25, Math.round((s.scene.durationSeconds / 5) * 4) / 4)),
      };
    }
    case 'logo-reveal-3d':
      return { ...base, text: clipOr(brandName ?? input.brief.title, 'Brand', 40) };
    case 'floating-shapes':
      return { ...base, headline: clipOrNull(s.scene.onScreenText, 120) };
    default:
      return base;
  }
}

function cameraFor(s: SceneSpecsSceneInput): CameraPreset | null {
  const t = s.choice.template;
  if (t === 'product-turntable') return s.isFirstInVideo ? 'dolly-in' : 'static';
  if (t === 'logo-reveal-3d') return 'push-in';
  if (t === 'floating-shapes') return 'orbit-right';
  const first = s.shots[0];
  if (!first) return null;
  // Leave every third scene null so the compiler derives it from the shot list.
  if (fnv1a(s.scene.id) % 3 === 0) return null;
  return cameraPresetForMovement(first.cameraMovement);
}

export function mockChapterSceneSpecs(input: SceneSpecsStageInput): ChapterSceneSpecsLlm {
  const p = genreProfile(input.request.genre);
  const topic = analyzeRequest(input.request, p);
  const stepScenes = input.scenes.filter((s) => s.choice.template === 'step-instruction');
  const scenes = input.scenes.map((s) => {
    const def = s.choice.template ? getTemplate(s.choice.template) : undefined;
    if (!def) throw new InternalDirectorError(`Scene "${s.scene.id}" has no catalog template`);
    // The director numbers steps across the whole video; fall back to chunk-local numbering without it.
    const stepIndex = stepScenes.indexOf(s);
    const stepInfo = s.step
      ? { stepNumber: s.step.stepNumber, totalSteps: s.step.totalSteps }
      : { stepNumber: Math.max(1, stepIndex + 1), totalSteps: Math.max(1, stepScenes.length) };
    const candidate = buildPropsFor(s, input, topic, stepInfo);
    const parsed = def.propsSchema.safeParse(candidate);
    let props: Props;
    if (parsed.success) {
      props = parsed.data;
    } else {
      const fallback = def.propsSchema.safeParse(
        def.buildProps({ title: s.scene.title, text: sceneText(s), bullets: [], palette: [...input.brief.visualStyle.palette], brandName: null }),
      );
      if (!fallback.success) throw new InternalDirectorError(`Template "${def.id}" buildProps produced invalid props`);
      props = fallback.data;
    }
    return { sceneId: s.scene.id, engine: def.engine, template: def.id, props, cameraPreset: cameraFor(s) };
  });
  // The union is keyed by template literal; the parsed objects match it structurally.
  return { chapterId: input.chapter.id, scenes } as ChapterSceneSpecsLlm;
}
