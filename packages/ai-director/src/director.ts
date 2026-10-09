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
import { computeCacheKey, type DirectorCache } from './cache';
import { compileTimeline } from './compiler';
import { digestPlan, digestReference, digestRequest } from './digest';
import { coerceEngineChoice, engineOptions, resolveEngineAvailability, type EngineAvailability } from './engines';
import {
  CancelledError,
  DirectorError,
  LimitExceededError,
  ProviderTruncatedError,
  toDirectorError,
  ValidationFailedError,
} from './errors';
import { planStructure, totalStepsFor, type StructurePlan } from './planning';
import { DEFAULT_PRICING, type PricingTable } from './pricing';
import { buildRepairPrompt, PROMPT_VERSION, renderPrompt, systemPromptFor } from './prompts';
import type { AIProvider, StructuredGenerationResult } from './provider';
import {
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
} from './stages';
import { toPromptJsonSchema } from './structured-output';
import { addUsage, UsageTracker, ZERO_USAGE } from './usage';
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
        });
        outcomes.push(outcome);
        sceneCount += outcome.scenes.length;
      }

      const artifacts: DirectorArtifacts = {
        brief,
        outline,
        script: { language: ctx.request.language, chapters: outcomes.map((o) => o.script) },
        storyboard: { scenes: outcomes.flatMap((o) => o.scenes) },
        shotList: { scenes: outcomes.flatMap((o) => o.shots) },
        engineSelection: { choices: outcomes.flatMap((o) => o.choices) },
        sceneSpecs: { scenes: outcomes.flatMap((o) => o.specs) },
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
    const run = this.startRun(opts);
    try {
      this.checkCancelled(run, null, null);
      const ctx = this.prepare(input);
      const parsedArtifacts = DirectorArtifactsSchema.safeParse(input.artifacts);
      if (!parsedArtifacts.success) {
        throw new ValidationFailedError('The artifacts to regenerate from are invalid', formatZodIssues(parsedArtifacts.error));
      }
      const artifacts = parsedArtifacts.data;
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
      const specs = await this.runSceneSpecs(run, ctx, artifacts.brief, chapter, [positioned], shots, choices, scenes.length, sceneId);

      const replaceById = <T>(items: readonly T[], key: (item: T) => string, replacement: T | undefined): T[] =>
        replacement === undefined ? [...items] : items.map((item) => (key(item) === sceneId ? replacement : item));
      const next: DirectorArtifacts = {
        ...artifacts,
        storyboard: { scenes: scenes.map((s, i) => (i === index ? newScene : s)) },
        shotList: { scenes: replaceById(artifacts.shotList.scenes, (s) => s.sceneId, shots[0]) },
        engineSelection: { choices: replaceById(artifacts.engineSelection.choices, (c) => c.sceneId, choices[0]) },
        sceneSpecs: { scenes: replaceById(artifacts.sceneSpecs.scenes, (s) => s.sceneId, specs[0]) },
      };
      return await this.finish(run, ctx, next);
    } catch (err) {
      throw this.fail(run, err);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Run helpers
  // -------------------------------------------------------------------------------------------

  private startRun(options: DirectorRunOptions): Run {
    return { options, usage: new UsageTracker(this.pricing), warnings: [], completedSteps: 0, totalSteps: 0 };
  }

  private fail(run: Run, err: unknown): DirectorError {
    const error = run.options.signal?.aborted && !(err instanceof DirectorError) ? new CancelledError(undefined, { cause: err }) : toDirectorError(err);
    error.usage = run.usage.report();
    error.warnings = [...run.warnings];
    this.logger.error?.('Director run failed', { code: error.code, message: error.message, stage: error.stage, chunk: error.chunk });
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

  private prepare(input: PlanProjectInput): RunContext {
    const parsed = VideoRequestSchema.safeParse(input.request);
    if (!parsed.success) throw new ValidationFailedError('Invalid video request', formatZodIssues(parsed.error));
    const request = parsed.data;
    const references: ReferenceProfile[] = [];
    (input.references ?? []).forEach((ref, i) => {
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

    const key = computeCacheKey({
      stage,
      chunk,
      promptVersion: this.promptVersion,
      provider: this.provider.name,
      model: this.provider.model,
      schemaName,
      system,
      prompt,
    });
    if (this.cache) {
      const hit = await this.cache.get(key, { stage, chunk });
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
    let latencyMs = 0;
    let attempts = 0;
    let servedModel = this.provider.model;
    let issues: string[] = [];
    const record = () => {
      if (attempts > 0) {
        run.usage.record({ stage, chunk, provider: this.provider.name, model: servedModel, attempts, cached: false, usage, latencyMs });
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
        if (err instanceof ProviderTruncatedError) {
          attempts += 1;
          latencyMs += Date.now() - started;
          if (err.tokenUsage) usage = addUsage(usage, err.tokenUsage);
          if (attempt < this.maxRepairAttempts) {
            issues = ['(root): the output was truncated at the max_tokens limit; return a complete but more concise JSON object'];
            attemptPrompt = buildRepairPrompt(prompt, issues, err.partialOutput ?? '');
            continue;
          }
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
      usage = addUsage(usage, result.usage);
      latencyMs += result.latencyMs;
      servedModel = result.model;

      const checked = this.validateOutput(schema, result.output, call.validate);
      if (checked.value !== null) {
        record();
        if (this.cache) {
          await this.cache.set(key, {
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
    if (brief.genre !== ctx.request.genre) {
      this.warn(run, `The brief proposed genre "${brief.genre}"; keeping the requested genre "${ctx.request.genre}".`);
      return { ...brief, genre: ctx.request.genre };
    }
    return brief;
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
      segments: rawScript.segments.map((s, k) => ({ ...s, id: `${chapter.id}-g${k + 1}` })),
    };

    // Storyboard.
    this.checkCancelled(run, 'storyboard', chapter.id);
    await this.progress(run, 'storyboard', chapter.id, `Storyboarding ${label}`);
    const segmentIdMap = new Map(rawScript.segments.map((s, k) => [s.id, `${chapter.id}-g${k + 1}`]));
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
            scenes: v.scenes.map((s) => ({ ...s, segmentIds: s.segmentIds.map((id) => segmentIdMap.get(id) ?? id) })),
          },
          { sceneRange: chapter.sceneRange, segmentIds: script.segments.map((s) => s.id) },
        ),
    });
    run.completedSteps += 1;
    const scenes = this.normalizeStoryboard(run, rawStoryboard.scenes, chapter, segmentIdMap, extra.firstSceneIndex);

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

    // Scene specs.
    this.checkCancelled(run, 'sceneSpecs', chapter.id);
    await this.progress(run, 'sceneSpecs', chapter.id, `Designing scenes for ${label}`);
    const specs = await this.runSceneSpecs(run, ctx, brief, chapter, positioned, shots, choices, totalScenes, chapter.id);

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
    segmentIdMap: ReadonlyMap<string, string>,
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
      segmentIds: s.segmentIds.map((id) => segmentIdMap.get(id) ?? id).filter((id, i, a) => a.indexOf(id) === i),
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
      return { sceneId: scene.id, shots: entry.shots.map((shot, j) => ({ ...shot, id: `sh${j + 1}` })) };
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
        hasCallToAction: brief.callToAction !== null,
        previousChoice,
      },
      validate: (v) => validateChapterEngineSelection(v, scenes),
    });
    run.completedSteps += 1;
    const byScene = new Map(selection.choices.map((c) => [c.sceneId, c]));
    return positioned.map((p) => {
      const choice = byScene.get(p.scene.id);
      if (!choice) throw new DirectorError('INTERNAL', `Missing engine choice for scene "${p.scene.id}"`);
      const { choice: coerced, warning } = coerceEngineChoice(choice, {
        genre: ctx.request.genre,
        availability: this.availability,
        isFirst: p.isFirstInVideo,
        isLast: p.isLastInVideo,
        hasCallToAction: brief.callToAction !== null,
      });
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
  ): Promise<SceneSpec[]> {
    const shotsByScene = new Map(shots.map((s) => [s.sceneId, s.shots]));
    const choiceByScene = new Map(choices.map((c) => [c.sceneId, c]));
    const templateIds = [...new Set(choices.map((c) => c.template).filter((t): t is string => t !== null))];
    const templates = templateIds.map(templateInfo).filter((t): t is SceneSpecTemplateInfo => t !== null);
    const specs: ChapterSceneSpecsLlm = await this.callStage(run, {
      stage: 'sceneSpecs',
      chunk,
      schema: STAGE_OUTPUT_SCHEMAS.sceneSpecs,
      input: {
        request: ctx.digest,
        brief,
        chapter,
        scenes: positioned.map((p) => {
          const choice = choiceByScene.get(p.scene.id);
          if (!choice) throw new DirectorError('INTERNAL', `Missing engine choice for scene "${p.scene.id}"`);
          return { ...p, shots: shotsByScene.get(p.scene.id) ?? [], choice };
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
