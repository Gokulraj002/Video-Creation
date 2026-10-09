import type { z } from 'zod';
import {
  AssetRefSchema,
  checkVideoRequestLimits,
  DEFAULT_RESOURCE_LIMITS,
  DirectorArtifactsSchema,
  formatZodIssues,
  getTemplate,
  ReferenceProfileSchema,
  validateTemplateProps,
  VideoRequestSchema,
  type AssetRef,
  type ChapterScript,
  type CreativeBrief,
  type DirectorArtifacts,
  type DirectorStage,
  type EngineChoice,
  type ReferenceProfile,
  type ResourceLimits,
  type SceneShots,
  type SceneSpec,
  type ScriptChapter,
  type ScriptOutline,
  type StoryboardScene,
  type Timeline,
  type TokenUsage,
  type UsageReport,
  type VideoRequest,
} from '@vc/schema';
import { computeCacheKey, hashStageInput, type DirectorCache } from './cache';
import { compileTimeline, isReservedId } from './compiler';
import { digestPlan, digestReference, digestRequest } from './digest';
import {
  assertCompilableEngineAvailable,
  coerceEngineChoice,
  engineOptions,
  resolveEngineAvailability,
  type EngineAvailability,
} from './engines';
import {
  CancelledError,
  DirectorError,
  LimitExceededError,
  ProviderRefusalError,
  ProviderTruncatedError,
  toDirectorError,
  ValidationFailedError,
} from './errors';
import { planStructure, totalStepsFor, type StructurePlan } from './planning';
import { DEFAULT_PRICING, type PricingTable } from './pricing';
import { buildRepairPrompt, PROMPT_VERSION, renderPrompt, systemPromptFor } from './prompts';
import type { AIProvider, StructuredGenerationResult } from './provider';
import {
  chapterSceneSpecsSchemaFor,
  STAGE_MAX_OUTPUT_TOKENS,
  STAGE_OUTPUT_SCHEMAS,
  STAGE_SCHEMA_NAMES,
  type ChapterContext,
  type ChapterSceneSpecsLlm,
  type LlmStage,
  type PlanDigest,
  type PositionedScene,
  type ReferenceDigest,
  type RequestDigest,
  type SceneSpecTemplateInfo,
  type StageInputMap,
  type StepPosition,
} from './stages';
import { toPromptJsonSchema } from './structured-output';
import { addUsage, UsageTracker, ZERO_USAGE, type ModelTokenUsage } from './usage';
import { parseJsonText } from './util/json';
import { clip, round } from './util/text';
import {
  validateChapterEngineSelection,
  validateChapterSceneSpecs,
  validateChapterScript,
  validateChapterShotList,
  validateChapterStoryboard,
  validateOutline,
} from './validators';

// =============================================================================================
// Public types
// =============================================================================================

export interface DirectorLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface AIDirectorOptions {
  provider: AIProvider;
  cache?: DirectorCache;
  pricing?: Readonly<PricingTable>;
  limits?: ResourceLimits;
  /** Extra attempts after a validation failure (default 2). */
  maxRepairAttempts?: number;
  /** Overrides merged over `DEFAULT_ENGINE_AVAILABILITY` (motion2d + three available). */
  engineAvailability?: Partial<EngineAvailability>;
  promptVersion?: string;
  logger?: DirectorLogger;
  /** Timeline id factory (default `tl-<uuid>`). */
  idFactory?: () => string;
  /** Clock for timestamps (default `new Date()`). */
  now?: () => Date;
}

export interface DirectorProgress {
  stage: DirectorStage;
  chunk: string | null;
  completedSteps: number;
  totalSteps: number;
  message: string;
}

export interface DirectorRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DirectorProgress) => void | Promise<void>;
}

export interface PlanProjectInput {
  request: VideoRequest;
  references?: ReferenceProfile[];
  assets?: AssetRef[];
}

export interface RegenerateSceneInput extends PlanProjectInput {
  artifacts: DirectorArtifacts;
  sceneId: string;
  instructions?: string;
}

export interface DirectorResult {
  artifacts: DirectorArtifacts;
  timeline: Timeline;
  usage: UsageReport;
  warnings: string[];
  plan: StructurePlan;
}

// =============================================================================================
// Internals
// =============================================================================================

interface Run {
  options: DirectorRunOptions;
  usage: UsageTracker;
  warnings: string[];
  completedSteps: number;
  totalSteps: number;
  /** Regenerations must produce a fresh take: their stage calls neither read nor write the cache. */
  bypassCache: boolean;
}

interface StageCall<S extends LlmStage, T> {
  stage: S;
  chunk: string | null;
  schema: z.ZodType<T>;
  input: StageInputMap[S];
  validate: (value: T) => string[];
}

interface RunContext {
  request: VideoRequest;
  digest: RequestDigest;
  references: ReferenceDigest[];
  assets: AssetRef[];
  plan: StructurePlan;
  planDigest: PlanDigest;
}

interface ChapterOutcome {
  script: ScriptChapter;
  scenes: StoryboardScene[];
  shots: SceneShots[];
  choices: EngineChoice[];
  specs: SceneSpec[];
}

const MAX_INSTRUCTIONS_CHARS = 2000;
const STORYBOARD_SCALE_WARNING = 0.1;
/** Max reference profiles per run (each one is digested into several stage prompts). Also capped by `limits.maxAssets`. */
export const MAX_REFERENCE_PROFILES = 20;
/** Stored storyboard durations (regenerateScene) may differ from the request duration by at most this factor. */
export const STORED_DURATION_MAX_RATIO = 10;
const DURATION_RESCALE_TOLERANCE = 1e-6;
const STEP_TEMPLATE = 'step-instruction';
/** `step-instruction` props allow step numbers up to 999. */
const MAX_STEP_NUMBER = 999;

/** Nullable LLM text where a blank string is meaningless ("" call to action, "   " narration) → null. */
function blankToNull(value: string | null): string | null {
  return value !== null && value.trim().length === 0 ? null : value;
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Global SOP step numbering: every `step-instruction` scene, in video order, numbered 1..N with totalSteps N
 * (clamped to the template's 999 limit).
 */
function stepPositions(order: readonly string[], templateByScene: ReadonlyMap<string, string | null>): Map<string, StepPosition> {
  const ids = order.filter((id) => templateByScene.get(id) === STEP_TEMPLATE);
  const total = Math.min(MAX_STEP_NUMBER, Math.max(1, ids.length));
  return new Map(ids.map((id, i) => [id, { stepNumber: Math.min(total, i + 1), totalSteps: total }]));
}

/** Tokens billed for a failed attempt (refusals and truncations are billed), or null when the error is not billed. */
function billedUsageOf(err: unknown, fallbackModel: string): ModelTokenUsage[] | null {
  if (!(err instanceof ProviderRefusalError) && !(err instanceof ProviderTruncatedError)) return null;
  if (err.usageByModel && err.usageByModel.length > 0) return err.usageByModel.map((p) => ({ model: p.model, usage: { ...p.usage } }));
  return [{ model: err.model ?? fallbackModel, usage: err.tokenUsage ? { ...err.tokenUsage } : { ...ZERO_USAGE } }];
}

function defaultIdFactory(): string {
  return `tl-${globalThis.crypto.randomUUID()}`;
}

function stageLabel(stage: LlmStage): string {
  switch (stage) {
    case 'brief':
      return 'creative brief';
    case 'outline':
      return 'script outline';
    case 'script':
      return 'script';
    case 'storyboard':
      return 'storyboard';
    case 'shotList':
      return 'shot list';
    case 'engineSelection':
      return 'engine selection';
    case 'sceneSpecs':
      return 'scene specs';
  }
}

const TEMPLATE_INFO_CACHE = new Map<string, SceneSpecTemplateInfo>();

function templateInfo(id: string): SceneSpecTemplateInfo | null {
  const cached = TEMPLATE_INFO_CACHE.get(id);
  if (cached) return cached;
  const t = getTemplate(id);
  if (!t) return null;
  const info: SceneSpecTemplateInfo = {
    id: t.id,
    engine: t.engine,
    name: t.name,
    description: t.description,
    propsJsonSchema: toPromptJsonSchema(t.propsSchema),
  };
  TEMPLATE_INFO_CACHE.set(id, info);
  return info;
}

/**
 * The AI Director pipeline: limits → brief → outline → per chapter (script → storyboard → shot list →
 * engine selection → scene specs) → deterministic compile. Every LLM output is Zod-validated, semantically
 * checked and repaired with fresh single-turn prompts; validated outputs are cached.
 */
export class AIDirector {
  private readonly provider: AIProvider;
  private readonly cache: DirectorCache | null;
  private readonly pricing: Readonly<PricingTable>;
  private readonly limits: ResourceLimits;
  private readonly maxRepairAttempts: number;
  private readonly availability: EngineAvailability;
  private readonly promptVersion: string;
  private readonly logger: DirectorLogger;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: AIDirectorOptions) {
    this.provider = options.provider;
    this.cache = options.cache ?? null;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
    this.limits = options.limits ?? DEFAULT_RESOURCE_LIMITS;
    this.maxRepairAttempts = Math.max(0, Math.floor(options.maxRepairAttempts ?? 2));
    this.availability = resolveEngineAvailability(options.engineAvailability);
    this.promptVersion = options.promptVersion ?? PROMPT_VERSION;
    this.logger = options.logger ?? {};
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.now = options.now ?? (() => new Date());
  }

  /** Engine availability used for selection and coercion. */
  get engineAvailability(): Readonly<EngineAvailability> {
    return this.availability;
  }

  /** Deterministic structure plan with the director's limits (no provider calls). */
  plan(request: VideoRequest, references: readonly ReferenceProfile[] = []): StructurePlan {
    return planStructure(request, references, this.limits);
  }

  // -------------------------------------------------------------------------------------------
  // planProject
  // -------------------------------------------------------------------------------------------

  async planProject(input: PlanProjectInput, opts: DirectorRunOptions = {}): Promise<DirectorResult> {
    const run = this.startRun(opts);
    try {
      this.checkCancelled(run, null, null);
      const ctx = this.prepare(input);
      run.totalSteps = totalStepsFor(ctx.plan);

      const brief = await this.runBrief(run, ctx);
      const outline = await this.runOutline(run, ctx, brief);

      const outcomes: ChapterOutcome[] = [];
      let sceneCount = 0;
      let stepCount = 0;
      for (let i = 0; i < outline.chapters.length; i++) {
        const chapter = this.chapterContext(outline, ctx.plan, i);
        this.checkCancelled(run, 'script', chapter.id);
        const previous = i > 0 ? outline.chapters[i - 1] : undefined;
        const next = outline.chapters[i + 1];
        const remainingEstimate = ctx.plan.perChapterSceneRange
          .slice(i + 1)
          .reduce((sum, r) => sum + Math.round((r.min + r.max) / 2), 0);
        const outcome = await this.runChapter(run, ctx, brief, chapter, {
          previousChapter: previous ? { title: previous.title, summary: previous.summary } : null,
          nextChapter: next ? { title: next.title, summary: next.summary } : null,
          firstSceneIndex: sceneCount,
          remainingScenesEstimate: remainingEstimate,
          stepsBefore: stepCount,
        });
        outcomes.push(outcome);
        sceneCount += outcome.scenes.length;
        stepCount += outcome.choices.filter((c) => c.template === STEP_TEMPLATE).length;
      }

      const storyboardScenes = outcomes.flatMap((o) => o.scenes);
      // SOP steps are numbered across the whole video (later chapters' step counts are unknown while earlier
      // chapters run, so the final numbers are enforced once every chapter is done).
      const numbered = this.numberSteps(
        storyboardScenes.map((s) => s.id),
        outcomes.flatMap((o) => o.specs),
      );
      const artifacts: DirectorArtifacts = {
        brief,
        outline,
        script: { language: ctx.request.language, chapters: outcomes.map((o) => o.script) },
        storyboard: { scenes: storyboardScenes },
        shotList: { scenes: outcomes.flatMap((o) => o.shots) },
        engineSelection: { choices: outcomes.flatMap((o) => o.choices) },
        sceneSpecs: { scenes: numbered.specs },
      };
      return await this.finish(run, ctx, artifacts);
    } catch (err) {
      throw this.fail(run, err);
    }
  }

  // -------------------------------------------------------------------------------------------
  // regenerateScene
  // -------------------------------------------------------------------------------------------

  async regenerateScene(input: RegenerateSceneInput, opts: DirectorRunOptions = {}): Promise<DirectorResult> {
    // A regeneration asks for a NEW take: never serve (or store) cached stage outputs.
    const run = this.startRun(opts, true);
    try {
      this.checkCancelled(run, null, null);
      const ctx = this.prepare(input);
      const parsedArtifacts = DirectorArtifactsSchema.safeParse(input.artifacts);
      if (!parsedArtifacts.success) {
        throw new ValidationFailedError('The artifacts to regenerate from are invalid', formatZodIssues(parsedArtifacts.error));
      }
      // Stored durations come from the caller: reject absurd values and fit them to the request before any call.
      const artifacts = this.normalizeStoredDurations(run, parsedArtifacts.data, ctx.request.durationSeconds);
      const scenes = artifacts.storyboard.scenes;
      const index = scenes.findIndex((s) => s.id === input.sceneId);
      const current = scenes[index];
      if (!current) throw new ValidationFailedError(`Unknown scene "${input.sceneId}"`, [`sceneId: no storyboard scene "${input.sceneId}"`]);
      const chapterIndex = artifacts.outline.chapters.findIndex((c) => c.id === current.chapterId);
      const outlineChapter = artifacts.outline.chapters[chapterIndex];
      const scriptChapter = artifacts.script.chapters.find((c) => c.id === current.chapterId);
      if (!outlineChapter || !scriptChapter) {
        throw new ValidationFailedError(`Scene "${input.sceneId}" references an unknown chapter`, [
          `storyboard.scenes.${index}.chapterId: unknown chapter "${current.chapterId}"`,
        ]);
      }
      const chapterScenes = scenes.filter((s) => s.chapterId === current.chapterId);
      const chapter: ChapterContext = {
        id: outlineChapter.id,
        index: chapterIndex,
        number: chapterIndex + 1,
        count: artifacts.outline.chapters.length,
        title: outlineChapter.title,
        summary: outlineChapter.summary,
        targetDurationSeconds: outlineChapter.targetDurationSeconds,
        sceneRange: { min: 1, max: 1 },
        isFirst: chapterIndex === 0,
        isLast: chapterIndex === artifacts.outline.chapters.length - 1,
      };
      const sceneId = current.id;
      run.totalSteps = 5;
      const instructions = input.instructions?.trim() ? clip(input.instructions, MAX_INSTRUCTIONS_CHARS) : null;
      const prevScene = scenes[index - 1];
      const nextScene = scenes[index + 1];
      const script: ChapterScript = { chapterId: scriptChapter.id, segments: scriptChapter.segments };

      // Storyboard (single scene).
      await this.progress(run, 'storyboard', sceneId, `Re-storyboarding scene "${sceneId}"`);
      const storyboard = await this.callStage(run, {
        stage: 'storyboard',
        chunk: sceneId,
        schema: STAGE_OUTPUT_SCHEMAS.storyboard,
        input: {
          request: ctx.digest,
          brief: artifacts.brief,
          chapter,
          script,
          targetSceneSeconds: ctx.plan.targetSceneSeconds,
          firstSceneIndex: index,
          references: ctx.references,
          regenerate: {
            sceneId,
            durationSeconds: current.durationSeconds,
            instructions,
            current,
            previousScene: prevScene ? { title: prevScene.title, visualDescription: prevScene.visualDescription } : null,
            nextScene: nextScene ? { title: nextScene.title, visualDescription: nextScene.visualDescription } : null,
            globalIndex: index,
            totalScenes: scenes.length,
          },
        },
        validate: (v) =>
          validateChapterStoryboard(v, { sceneRange: { min: 1, max: 1 }, segmentIds: script.segments.map((s) => s.id) }),
      });
      run.completedSteps += 1;
      const produced = storyboard.scenes[0];
      if (!produced) throw new ValidationFailedError('Regenerated storyboard is empty', ['scenes: expected exactly 1 scene']);
      const newScene: StoryboardScene = {
        ...produced,
        id: sceneId,
        chapterId: current.chapterId,
        voiceOver: blankToNull(produced.voiceOver),
        onScreenText: blankToNull(produced.onScreenText),
        durationSeconds: current.durationSeconds,
        transitionIn: index === 0 ? 'cut' : produced.transitionIn,
      };

      const positioned: PositionedScene = {
        scene: newScene,
        globalIndex: index,
        isFirstInVideo: index === 0,
        isLastInVideo: index === scenes.length - 1,
        isFirstInChapter: chapterScenes[0]?.id === sceneId,
        isLastInChapter: chapterScenes[chapterScenes.length - 1]?.id === sceneId,
      };
      this.checkCancelled(run, 'shotList', sceneId);
      await this.progress(run, 'shotList', sceneId, `Planning shots for scene "${sceneId}"`);
      const shots = await this.runShotList(run, ctx, artifacts.brief, chapter, [newScene], sceneId);
      const previousChoice = artifacts.engineSelection.choices.find((c) => c.sceneId === sceneId) ?? null;
      this.checkCancelled(run, 'engineSelection', sceneId);
      await this.progress(run, 'engineSelection', sceneId, `Choosing the engine for scene "${sceneId}"`);
      const choices = await this.runEngineSelection(run, ctx, artifacts.brief, chapter, [positioned], scenes.length, sceneId, previousChoice);
      this.checkCancelled(run, 'sceneSpecs', sceneId);
      await this.progress(run, 'sceneSpecs', sceneId, `Designing scene "${sceneId}"`);
      // Global step position from the existing artifacts, with this scene's new template.
      const order = scenes.map((s) => s.id);
      const templateByScene = new Map<string, string | null>(artifacts.sceneSpecs.scenes.map((s) => [s.sceneId, s.template]));
      const newChoice = choices[0];
      if (newChoice) templateByScene.set(sceneId, newChoice.template);
      const step = stepPositions(order, templateByScene).get(sceneId);
      const specs = await this.runSceneSpecs(
        run,
        ctx,
        artifacts.brief,
        chapter,
        [positioned],
        shots,
        choices,
        scenes.length,
        sceneId,
        new Map(step ? [[sceneId, step]] : []),
      );

      const replaceById = <T>(items: readonly T[], key: (item: T) => string, replacement: T | undefined): T[] =>
        replacement === undefined ? [...items] : items.map((item) => (key(item) === sceneId ? replacement : item));
      const numbered = this.numberSteps(order, replaceById(artifacts.sceneSpecs.scenes, (s) => s.sceneId, specs[0]));
      const renumbered = numbered.changed.filter((id) => id !== sceneId);
      if (renumbered.length > 0) {
        this.warn(
          run,
          `Step numbering was updated for ${renumbered.length} other scene(s) so SOP steps stay numbered across the whole video.`,
        );
      }
      const next: DirectorArtifacts = {
        ...artifacts,
        storyboard: { scenes: scenes.map((s, i) => (i === index ? newScene : s)) },
        shotList: { scenes: replaceById(artifacts.shotList.scenes, (s) => s.sceneId, shots[0]) },
        engineSelection: { choices: replaceById(artifacts.engineSelection.choices, (c) => c.sceneId, choices[0]) },
        sceneSpecs: { scenes: numbered.specs },
      };
      return await this.finish(run, ctx, next);
    } catch (err) {
      throw this.fail(run, err);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Run helpers
  // -------------------------------------------------------------------------------------------

  private startRun(options: DirectorRunOptions, bypassCache = false): Run {
    return { options, usage: new UsageTracker(this.pricing), warnings: [], completedSteps: 0, totalSteps: 0, bypassCache };
  }

  private fail(run: Run, err: unknown): DirectorError {
    const error = run.options.signal?.aborted && !(err instanceof DirectorError) ? new CancelledError(undefined, { cause: err }) : toDirectorError(err);
    error.usage = run.usage.report();
    error.warnings = [...run.warnings];
    const meta = { code: error.code, message: error.message, stage: error.stage, chunk: error.chunk };
    // A cancellation is a normal outcome requested by the caller, not an error.
    if (error.code === 'CANCELLED') this.logger.info?.('Director run cancelled', meta);
    else this.logger.error?.('Director run failed', meta);
    return error;
  }

  private checkCancelled(run: Run, stage: DirectorStage | null, chunk: string | null): void {
    if (run.options.signal?.aborted) throw new CancelledError('The director run was cancelled', { stage, chunk });
  }

  private async progress(run: Run, stage: DirectorStage, chunk: string | null, message: string): Promise<void> {
    const cb = run.options.onProgress;
    if (!cb) return;
    try {
      await cb({ stage, chunk, completedSteps: run.completedSteps, totalSteps: run.totalSteps, message });
    } catch (err) {
      this.logger.warn?.('onProgress callback failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private warn(run: Run, message: string): void {
    run.warnings.push(message);
    this.logger.warn?.(message);
  }

  /** Validates everything a run needs BEFORE any provider call (config, request, references, assets, limits). */
  private prepare(input: PlanProjectInput): RunContext {
    assertCompilableEngineAvailable(this.availability);
    const parsed = VideoRequestSchema.safeParse(input.request);
    if (!parsed.success) throw new ValidationFailedError('Invalid video request', formatZodIssues(parsed.error));
    const request = parsed.data;
    const rawReferences = input.references ?? [];
    const maxReferences = Math.min(MAX_REFERENCE_PROFILES, this.limits.maxAssets);
    if (rawReferences.length > maxReferences) {
      const message = `Reference profile count ${rawReferences.length} exceeds the limit of ${maxReferences}`;
      throw new LimitExceededError(message, [{ code: 'MAX_ASSETS', message, limit: maxReferences, actual: rawReferences.length }]);
    }
    const references: ReferenceProfile[] = [];
    rawReferences.forEach((ref, i) => {
      const r = ReferenceProfileSchema.safeParse(ref);
      if (!r.success) {
        throw new ValidationFailedError(`Invalid reference profile #${i}`, formatZodIssues(r.error).map((m) => `references.${i}.${m}`));
      }
      references.push(r.data);
    });
    const assets: AssetRef[] = [];
    (input.assets ?? []).forEach((asset, i) => {
      const a = AssetRefSchema.safeParse(asset);
      if (!a.success) {
        throw new ValidationFailedError(`Invalid asset #${i}`, formatZodIssues(a.error).map((m) => `assets.${i}.${m}`));
      }
      assets.push(a.data);
    });
    // Asset ids share the timeline's id namespace with the ids the director generates; collisions (or duplicates)
    // would only surface when compiling, after every provider call.
    const assetIssues: string[] = [];
    const firstIndex = new Map<string, number>();
    assets.forEach((asset, i) => {
      if (isReservedId(asset.id)) {
        assetIssues.push(
          `assets.${i}.id: "${asset.id}" is reserved for ids the director generates (chapters c<n>, scenes c<n>-s<m>, ` +
            'caption cues c<n>-s<m>-cap<k>, the "captions" track, shots sh<n>, segments c<n>-g<k>); use a different asset id',
        );
      }
      const first = firstIndex.get(asset.id);
      if (first !== undefined) assetIssues.push(`assets.${i}.id: duplicate asset id "${asset.id}" (already used by assets.${first})`);
      else firstIndex.set(asset.id, i);
    });
    if (assetIssues.length > 0) throw new ValidationFailedError('Invalid asset ids', assetIssues);
    const violations = checkVideoRequestLimits(request, this.limits);
    if (assets.length > this.limits.maxAssets) {
      violations.push({
        code: 'MAX_ASSETS',
        message: `Asset count ${assets.length} exceeds the configured limit of ${this.limits.maxAssets}`,
        limit: this.limits.maxAssets,
        actual: assets.length,
      });
    }
    if (violations.length > 0) {
      throw new LimitExceededError(violations.map((v) => v.message).join('; '), violations);
    }
    const plan = planStructure(request, references, this.limits);
    return {
      request,
      digest: digestRequest(request),
      references: references.map(digestReference),
      assets,
      plan,
      planDigest: digestPlan(plan),
    };
  }

  /**
   * regenerateScene: stored storyboard durations must be finite, > 0 and (in total) within
   * {@link STORED_DURATION_MAX_RATIO}× of the request duration; otherwise the run fails with VALIDATION_FAILED before
   * any provider call. Totals that differ from the request duration are rescaled uniformly (frames are allocated
   * proportionally, so relative timing is kept).
   */
  private normalizeStoredDurations(run: Run, artifacts: DirectorArtifacts, requestSeconds: number): DirectorArtifacts {
    const scenes = artifacts.storyboard.scenes;
    const issues: string[] = [];
    scenes.forEach((s, i) => {
      if (!Number.isFinite(s.durationSeconds) || s.durationSeconds <= 0) {
        issues.push(`storyboard.scenes.${i}.durationSeconds: must be a finite number > 0 (got ${String(s.durationSeconds)})`);
      }
    });
    const total = scenes.reduce((a, s) => a + s.durationSeconds, 0);
    if (issues.length === 0) {
      const ratio = total / requestSeconds;
      if (!Number.isFinite(total) || !(ratio <= STORED_DURATION_MAX_RATIO && ratio >= 1 / STORED_DURATION_MAX_RATIO)) {
        issues.push(
          `storyboard.scenes: durations sum to ${String(round(total, 3))} s, which does not fit the requested ${requestSeconds} s ` +
            `(must be within ${STORED_DURATION_MAX_RATIO}×); re-plan the project instead`,
        );
      }
    }
    if (issues.length > 0) throw new ValidationFailedError('The stored storyboard durations are invalid', issues, { stage: 'storyboard' });
    if (Math.abs(total / requestSeconds - 1) <= DURATION_RESCALE_TOLERANCE) return artifacts;
    const factor = requestSeconds / total;
    this.warn(run, `Stored storyboard durations summed to ${round(total, 2)} s (request ${round(requestSeconds, 2)} s); scaled to fit.`);
    return {
      ...artifacts,
      storyboard: { scenes: scenes.map((s) => ({ ...s, durationSeconds: Math.max(1e-6, s.durationSeconds * factor) })) },
    };
  }

  /** Enforces global step numbering on `step-instruction` specs; returns the specs and the ids whose props changed. */
  private numberSteps(order: readonly string[], specs: readonly SceneSpec[]): { specs: SceneSpec[]; changed: string[] } {
    const positions = stepPositions(order, new Map(specs.map((s) => [s.sceneId, s.template])));
    const changed: string[] = [];
    const out = specs.map((spec) => {
      const pos = positions.get(spec.sceneId);
      if (!pos || (spec.props.stepNumber === pos.stepNumber && spec.props.totalSteps === pos.totalSteps)) return spec;
      const props = validateTemplateProps(spec.template, { ...spec.props, stepNumber: pos.stepNumber, totalSteps: pos.totalSteps });
      if (!props.success) return spec;
      changed.push(spec.sceneId);
      return { ...spec, props: props.data };
    });
    return { specs: out, changed };
  }

  private chapterContext(outline: ScriptOutline, plan: StructurePlan, index: number): ChapterContext {
    const c = outline.chapters[index];
    if (!c) throw new DirectorError('INTERNAL', `Missing outline chapter ${index}`);
    return {
      id: c.id,
      index,
      number: index + 1,
      count: outline.chapters.length,
      title: c.title,
      summary: c.summary,
      targetDurationSeconds: c.targetDurationSeconds,
      sceneRange: plan.perChapterSceneRange[index] ?? { min: 1, max: 1 },
      isFirst: index === 0,
      isLast: index === outline.chapters.length - 1,
    };
  }

  private async finish(run: Run, ctx: RunContext, artifacts: DirectorArtifacts): Promise<DirectorResult> {
    this.checkCancelled(run, 'compile', null);
    await this.progress(run, 'compile', null, 'Compiling the timeline');
    const validated = DirectorArtifactsSchema.safeParse(artifacts);
    if (!validated.success) {
      throw new DirectorError('INTERNAL', `Assembled artifacts are invalid: ${formatZodIssues(validated.error, 5).join('; ')}`, {
        stage: 'compile',
        details: { issues: formatZodIssues(validated.error) },
      });
    }
    const { timeline, warnings } = compileTimeline({
      request: ctx.request,
      artifacts: validated.data,
      assets: ctx.assets,
      limits: this.limits,
      promptVersion: this.promptVersion,
      timelineId: this.idFactory(),
      createdAt: this.now().toISOString(),
    });
    for (const w of warnings) this.warn(run, w);
    run.completedSteps = run.totalSteps;
    await this.progress(run, 'compile', null, 'Timeline ready');
    return { artifacts: validated.data, timeline, usage: run.usage.report(), warnings: [...run.warnings], plan: ctx.plan };
  }

  // -------------------------------------------------------------------------------------------
  // Stage call with cache + repair loop
  // -------------------------------------------------------------------------------------------

  private validateOutput<T>(schema: z.ZodType<T>, output: unknown, validate: (value: T) => string[]): { value: T | null; issues: string[] } {
    let candidate = output;
    if (typeof candidate === 'string') {
      const json = parseJsonText(candidate);
      if (!json.ok) return { value: null, issues: [`(root): output is not valid JSON (${json.error})`] };
      candidate = json.value;
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) return { value: null, issues: formatZodIssues(parsed.error, 100) };
    const semantic = validate(parsed.data);
    return semantic.length > 0 ? { value: null, issues: semantic } : { value: parsed.data, issues: [] };
  }

  private async callStage<S extends LlmStage, T>(run: Run, call: StageCall<S, T>): Promise<T> {
    const { stage, chunk, schema } = call;
    const system = systemPromptFor(stage);
    const prompt = renderPrompt(stage, call.input);
    const schemaName = STAGE_SCHEMA_NAMES[stage];
    this.checkCancelled(run, stage, chunk);

    // The key covers the rendered prompt AND the structured input (mock providers build their output from it and
    // not every input field is rendered) plus every provider setting that can change outputs.
    const cache = run.bypassCache ? null : this.cache;
    const key = cache
      ? computeCacheKey({
          stage,
          chunk,
          promptVersion: this.promptVersion,
          provider: this.provider.name,
          model: this.provider.model,
          schemaName,
          system,
          prompt,
          inputHash: hashStageInput(call.input),
          providerFingerprint: this.provider.configFingerprint ?? null,
        })
      : '';
    if (cache) {
      const hit = await cache.get(key, { stage, chunk });
      if (hit) {
        const checked = this.validateOutput(schema, hit.output, call.validate);
        if (checked.value !== null) {
          run.usage.record({ stage, chunk, provider: this.provider.name, model: hit.model, attempts: 1, cached: true, usage: ZERO_USAGE, latencyMs: 0 });
          this.logger.debug?.('Director cache hit', { stage, chunk });
          return checked.value;
        }
        this.logger.warn?.('Ignoring invalid cache entry', { stage, chunk });
      }
    }

    let attemptPrompt = prompt;
    let usage: TokenUsage = { ...ZERO_USAGE };
    /** Per-model usage of every attempt (attempts and fallback hops may be served by different models). */
    const parts: ModelTokenUsage[] = [];
    let latencyMs = 0;
    let attempts = 0;
    let servedModel = this.provider.model;
    let issues: string[] = [];
    const record = () => {
      if (attempts > 0) {
        run.usage.record({
          stage,
          chunk,
          provider: this.provider.name,
          model: servedModel,
          attempts,
          cached: false,
          usage,
          usageByModel: parts,
          latencyMs,
        });
      }
    };
    const addParts = (billed: readonly ModelTokenUsage[]) => {
      for (const part of billed) {
        parts.push(part);
        usage = addUsage(usage, part.usage);
      }
    };

    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      if (run.options.signal?.aborted) {
        record();
        throw new CancelledError('The director run was cancelled', { stage, chunk });
      }
      let result: StructuredGenerationResult;
      const started = Date.now();
      try {
        result = await this.provider.generateStructured({
          stage,
          chunk,
          system,
          prompt: attemptPrompt,
          input: call.input,
          schema,
          schemaName,
          maxOutputTokens: STAGE_MAX_OUTPUT_TOKENS[stage],
          ...(run.options.signal ? { signal: run.options.signal } : {}),
        });
      } catch (err) {
        // Refused and truncated responses are billed: count the attempt and its tokens.
        const billed = billedUsageOf(err, this.provider.model);
        if (billed) {
          attempts += 1;
          latencyMs += Date.now() - started;
          addParts(billed);
          const last = billed[billed.length - 1];
          if (last) servedModel = last.model;
        }
        if (err instanceof ProviderTruncatedError && attempt < this.maxRepairAttempts) {
          issues = ['(root): the output was truncated at the max_tokens limit; return a complete but more concise JSON object'];
          attemptPrompt = buildRepairPrompt(prompt, issues, err.partialOutput ?? '');
          continue;
        }
        record();
        if (run.options.signal?.aborted && !(err instanceof DirectorError)) {
          throw new CancelledError('The director run was cancelled', { stage, chunk, cause: err });
        }
        const error = toDirectorError(err);
        if (error.stage === null) error.stage = stage;
        if (error.chunk === null) error.chunk = chunk;
        throw error;
      }
      attempts += 1;
      addParts(result.usageByModel && result.usageByModel.length > 0 ? result.usageByModel : [{ model: result.model, usage: result.usage }]);
      latencyMs += result.latencyMs;
      servedModel = result.model;

      const checked = this.validateOutput(schema, result.output, call.validate);
      if (checked.value !== null) {
        record();
        if (cache) {
          await cache.set(key, {
            stage,
            chunk,
            output: checked.value,
            usage,
            provider: this.provider.name,
            model: servedModel,
            createdAt: this.now().toISOString(),
          });
        }
        return checked.value;
      }
      issues = checked.issues;
      this.logger.warn?.('Stage output failed validation', { stage, chunk, attempt: attempt + 1, issues: issues.slice(0, 10) });
      attemptPrompt = buildRepairPrompt(prompt, issues, result.output);
    }

    record();
    throw new ValidationFailedError(
      `The ${stageLabel(stage)}${chunk ? ` (${chunk})` : ''} failed validation after ${attempts} attempt(s)`,
      issues,
      { stage, chunk },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Stages
  // -------------------------------------------------------------------------------------------

  private async runBrief(run: Run, ctx: RunContext): Promise<CreativeBrief> {
    await this.progress(run, 'brief', null, 'Writing the creative brief');
    const brief = await this.callStage(run, {
      stage: 'brief',
      chunk: null,
      schema: STAGE_OUTPUT_SCHEMAS.brief,
      input: { request: ctx.digest, references: ctx.references, plan: ctx.planDigest },
      validate: () => [],
    });
    run.completedSteps += 1;
    // A blank call to action ("") is no call to action.
    const normalized: CreativeBrief = {
      ...brief,
      callToAction: blankToNull(brief.callToAction),
      referenceInfluence: blankToNull(brief.referenceInfluence),
    };
    if (normalized.genre !== ctx.request.genre) {
      this.warn(run, `The brief proposed genre "${normalized.genre}"; keeping the requested genre "${ctx.request.genre}".`);
      return { ...normalized, genre: ctx.request.genre };
    }
    return normalized;
  }

  private async runOutline(run: Run, ctx: RunContext, brief: CreativeBrief): Promise<ScriptOutline> {
    await this.progress(run, 'outline', null, 'Outlining the chapters');
    const outline = await this.callStage(run, {
      stage: 'outline',
      chunk: null,
      schema: STAGE_OUTPUT_SCHEMAS.outline,
      input: { request: ctx.digest, references: ctx.references, brief, plan: ctx.planDigest },
      validate: (v) => validateOutline(v, { chapterCount: ctx.plan.chapterCount, totalSeconds: ctx.plan.durationSeconds }),
    });
    run.completedSteps += 1;
    // Stable ids and exact plan targets (frames are allocated from the plan, not the model's arithmetic).
    return {
      chapters: outline.chapters.map((c, i) => ({
        ...c,
        id: `c${i + 1}`,
        targetDurationSeconds: ctx.plan.chapterTargetSeconds[i] ?? c.targetDurationSeconds,
      })),
    };
  }

  private async runChapter(
    run: Run,
    ctx: RunContext,
    brief: CreativeBrief,
    chapter: ChapterContext,
    extra: {
      previousChapter: { title: string; summary: string } | null;
      nextChapter: { title: string; summary: string } | null;
      firstSceneIndex: number;
      remainingScenesEstimate: number;
      /** step-instruction scenes in the chapters before this one. */
      stepsBefore: number;
    },
  ): Promise<ChapterOutcome> {
    const label = `chapter ${chapter.number}/${chapter.count}`;

    // Script.
    await this.progress(run, 'script', chapter.id, `Writing the script for ${label}`);
    const maxSegments = Math.max(1, Math.ceil(chapter.sceneRange.max * 1.5));
    const rawScript = await this.callStage(run, {
      stage: 'script',
      chunk: chapter.id,
      schema: STAGE_OUTPUT_SCHEMAS.script,
      input: {
        request: ctx.digest,
        brief,
        chapter,
        targetSceneSeconds: ctx.plan.targetSceneSeconds,
        maxSegments,
        previousChapter: extra.previousChapter,
        nextChapter: extra.nextChapter,
      },
      validate: (v) => validateChapterScript(v, { targetDurationSeconds: chapter.targetDurationSeconds, maxSegments }),
    });
    run.completedSteps += 1;
    const script: ChapterScript = {
      chapterId: chapter.id,
      segments: rawScript.segments.map((s, k) => ({
        ...s,
        id: `${chapter.id}-g${k + 1}`,
        voiceOver: blankToNull(s.voiceOver),
        onScreenText: blankToNull(s.onScreenText),
      })),
    };

    // Storyboard.
    this.checkCancelled(run, 'storyboard', chapter.id);
    await this.progress(run, 'storyboard', chapter.id, `Storyboarding ${label}`);
    // The storyboard prompt shows the director's segment ids; the model's own script ids are accepted as aliases,
    // but a director id always wins (a model id such as "c1-g1" may alias a DIFFERENT segment).
    const directorSegmentIds = new Set(script.segments.map((s) => s.id));
    const aliasMap = new Map(rawScript.segments.map((s, k) => [s.id, `${chapter.id}-g${k + 1}`]));
    const resolveSegmentId = (id: string): string => (directorSegmentIds.has(id) ? id : (aliasMap.get(id) ?? id));
    const rawStoryboard = await this.callStage(run, {
      stage: 'storyboard',
      chunk: chapter.id,
      schema: STAGE_OUTPUT_SCHEMAS.storyboard,
      input: {
        request: ctx.digest,
        brief,
        chapter,
        script,
        targetSceneSeconds: ctx.plan.targetSceneSeconds,
        firstSceneIndex: extra.firstSceneIndex,
        references: ctx.references,
        regenerate: null,
      },
      validate: (v) =>
        validateChapterStoryboard(
          {
            ...v,
            // Accept either the director's ids or the model's original segment ids.
            scenes: v.scenes.map((s) => ({ ...s, segmentIds: s.segmentIds.map(resolveSegmentId) })),
          },
          { sceneRange: chapter.sceneRange, segmentIds: script.segments.map((s) => s.id) },
        ),
    });
    run.completedSteps += 1;
    const scenes = this.normalizeStoryboard(run, rawStoryboard.scenes, chapter, resolveSegmentId, extra.firstSceneIndex);

    // Shot list.
    this.checkCancelled(run, 'shotList', chapter.id);
    await this.progress(run, 'shotList', chapter.id, `Planning shots for ${label}`);
    const shots = await this.runShotList(run, ctx, brief, chapter, scenes, chapter.id);

    // Engine selection.
    this.checkCancelled(run, 'engineSelection', chapter.id);
    await this.progress(run, 'engineSelection', chapter.id, `Choosing engines for ${label}`);
    const positioned: PositionedScene[] = scenes.map((scene, m) => ({
      scene,
      globalIndex: extra.firstSceneIndex + m,
      isFirstInVideo: extra.firstSceneIndex + m === 0,
      isLastInVideo: chapter.isLast && m === scenes.length - 1,
      isFirstInChapter: m === 0,
      isLastInChapter: m === scenes.length - 1,
    }));
    const totalScenes = extra.firstSceneIndex + scenes.length + (chapter.isLast ? 0 : extra.remainingScenesEstimate);
    const choices = await this.runEngineSelection(run, ctx, brief, chapter, positioned, totalScenes, chapter.id, null);

    // Global SOP step numbers: steps of earlier chapters + this chapter's; later chapters are estimated from the
    // step ratio so far (planProject enforces the exact numbers once every chapter is done).
    const chapterStepIds = choices.filter((c) => c.template === STEP_TEMPLATE).map((c) => c.sceneId);
    const stepsSoFar = extra.stepsBefore + chapterStepIds.length;
    const scenesSoFar = extra.firstSceneIndex + scenes.length;
    const estimatedSteps = chapter.isLast ? stepsSoFar : stepsSoFar + Math.round((extra.remainingScenesEstimate * stepsSoFar) / Math.max(1, scenesSoFar));
    const totalSteps = Math.min(MAX_STEP_NUMBER, Math.max(1, estimatedSteps));
    const steps = new Map<string, StepPosition>(
      chapterStepIds.map((id, k) => [id, { stepNumber: Math.min(totalSteps, extra.stepsBefore + k + 1), totalSteps }]),
    );

    // Scene specs.
    this.checkCancelled(run, 'sceneSpecs', chapter.id);
    await this.progress(run, 'sceneSpecs', chapter.id, `Designing scenes for ${label}`);
    const specs = await this.runSceneSpecs(run, ctx, brief, chapter, positioned, shots, choices, totalScenes, chapter.id, steps);

    return {
      script: {
        id: chapter.id,
        title: chapter.title,
        summary: chapter.summary,
        targetDurationSeconds: chapter.targetDurationSeconds,
        segments: script.segments,
      },
      scenes,
      shots,
      choices,
      specs,
    };
  }

  /** Remaps ids to `c{n}-s{m}`, coerces chapter ids, forces a cut into the first scene and scales durations to the chapter target. */
  private normalizeStoryboard(
    run: Run,
    raw: readonly StoryboardScene[],
    chapter: ChapterContext,
    resolveSegmentId: (id: string) => string,
    firstSceneIndex: number,
  ): StoryboardScene[] {
    const sum = raw.reduce((a, s) => a + s.durationSeconds, 0);
    const factor = sum > 0 ? chapter.targetDurationSeconds / sum : 1;
    if (Math.abs(factor - 1) > STORYBOARD_SCALE_WARNING) {
      this.warn(
        run,
        `Chapter "${chapter.id}": storyboard durations summed to ${round(sum, 2)} s (target ${round(chapter.targetDurationSeconds, 2)} s); scaled to fit.`,
      );
    }
    return raw.map((s, m) => ({
      ...s,
      id: `${chapter.id}-s${m + 1}`,
      chapterId: chapter.id,
      segmentIds: s.segmentIds.map(resolveSegmentId).filter((id, i, a) => a.indexOf(id) === i),
      voiceOver: blankToNull(s.voiceOver),
      onScreenText: blankToNull(s.onScreenText),
      durationSeconds: Math.max(1e-6, s.durationSeconds * factor),
      transitionIn: firstSceneIndex + m === 0 ? 'cut' : s.transitionIn,
    }));
  }

  private async runShotList(
    run: Run,
    ctx: RunContext,
    brief: CreativeBrief,
    chapter: ChapterContext,
    scenes: StoryboardScene[],
    chunk: string,
  ): Promise<SceneShots[]> {
    const shotList = await this.callStage(run, {
      stage: 'shotList',
      chunk,
      schema: STAGE_OUTPUT_SCHEMAS.shotList,
      input: { request: ctx.digest, brief, chapter, scenes, references: ctx.references },
      validate: (v) => validateChapterShotList(v, scenes),
    });
    run.completedSteps += 1;
    const byScene = new Map(shotList.scenes.map((s) => [s.sceneId, s]));
    return scenes.map((scene) => {
      const entry = byScene.get(scene.id);
      if (!entry) throw new DirectorError('INTERNAL', `Missing shot list for scene "${scene.id}"`);
      return { sceneId: scene.id, shots: entry.shots.map((shot, j) => ({ ...shot, id: `sh${j + 1}`, notes: blankToNull(shot.notes) })) };
    });
  }

  private async runEngineSelection(
    run: Run,
    ctx: RunContext,
    brief: CreativeBrief,
    chapter: ChapterContext,
    positioned: PositionedScene[],
    totalScenes: number,
    chunk: string,
    previousChoice: EngineChoice | null,
  ): Promise<EngineChoice[]> {
    const scenes = positioned.map((p) => p.scene);
    const selection = await this.callStage(run, {
      stage: 'engineSelection',
      chunk,
      schema: STAGE_OUTPUT_SCHEMAS.engineSelection,
      input: {
        request: ctx.digest,
        brief,
        chapter,
        scenes: positioned,
        totalScenes,
        engines: engineOptions(this.availability),
        hasCallToAction: hasText(brief.callToAction),
        previousChoice,
      },
      validate: (v) => validateChapterEngineSelection(v, scenes),
    });
    run.completedSteps += 1;
    const byScene = new Map(selection.choices.map((c) => [c.sceneId, c]));
    return positioned.map((p) => {
      const choice = byScene.get(p.scene.id);
      if (!choice) throw new DirectorError('INTERNAL', `Missing engine choice for scene "${p.scene.id}"`);
      const { choice: coerced, warning } = coerceEngineChoice(
        { ...choice, provider: blankToNull(choice.provider) },
        {
          genre: ctx.request.genre,
          availability: this.availability,
          isFirst: p.isFirstInVideo,
          isLast: p.isLastInVideo,
          hasCallToAction: hasText(brief.callToAction),
        },
      );
      if (warning) this.warn(run, warning);
      return coerced;
    });
  }

  private async runSceneSpecs(
    run: Run,
    ctx: RunContext,
    brief: CreativeBrief,
    chapter: ChapterContext,
    positioned: PositionedScene[],
    shots: SceneShots[],
    choices: EngineChoice[],
    totalScenes: number,
    chunk: string,
    steps: ReadonlyMap<string, StepPosition>,
  ): Promise<SceneSpec[]> {
    const shotsByScene = new Map(shots.map((s) => [s.sceneId, s.shots]));
    const choiceByScene = new Map(choices.map((c) => [c.sceneId, c]));
    const templateIds = [...new Set(choices.map((c) => c.template).filter((t): t is string => t !== null))];
    const templates = templateIds.map(templateInfo).filter((t): t is SceneSpecTemplateInfo => t !== null);
    const specs: ChapterSceneSpecsLlm = await this.callStage(run, {
      stage: 'sceneSpecs',
      chunk,
      // Only the selected templates: a far smaller structured-output schema than the whole catalog.
      schema: chapterSceneSpecsSchemaFor(templateIds),
      input: {
        request: ctx.digest,
        brief,
        chapter,
        scenes: positioned.map((p) => {
          const choice = choiceByScene.get(p.scene.id);
          if (!choice) throw new DirectorError('INTERNAL', `Missing engine choice for scene "${p.scene.id}"`);
          return { ...p, shots: shotsByScene.get(p.scene.id) ?? [], choice, step: steps.get(p.scene.id) ?? null };
        }),
        totalScenes,
        templates,
        imageAssetIds: ctx.assets.filter((a) => a.kind === 'image').map((a) => a.id),
      },
      validate: (v) => validateChapterSceneSpecs(v, choices),
    });
    run.completedSteps += 1;
    const bySceneId = new Map(specs.scenes.map((s) => [s.sceneId, s]));
    return positioned.map((p) => {
      const spec = bySceneId.get(p.scene.id);
      if (!spec) throw new DirectorError('INTERNAL', `Missing scene spec for scene "${p.scene.id}"`);
      const props = validateTemplateProps(spec.template, spec.props);
      if (!props.success) throw new DirectorError('INTERNAL', `Validated props became invalid for scene "${p.scene.id}"`);
      return { sceneId: p.scene.id, engine: spec.engine, template: spec.template, props: props.data, cameraPreset: spec.cameraPreset };
    });
  }
}
