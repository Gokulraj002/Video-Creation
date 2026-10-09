import { z } from 'zod';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from '@vc/schema';

/** Per-model token pricing (USD per million tokens), same shape as `@vc/ai-director` pricing entries. */
export interface ModelPricingConfig {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface AnthropicConfig {
  apiKey: string | undefined;
  model: string;
  effort: string;
  maxOutputTokens: number;
  fallbacks: 'default' | 'off';
  structuredOutput: 'json_schema' | 'prompt';
}

/** Largest delay `setTimeout` honours (2^31 − 1 ms ≈ 24.8 days); longer delays fire immediately. */
export const MAX_TIMER_MS = 2_147_483_647;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  /** pg pool of each Prisma client (API and worker processes have one each). */
  databasePool: {
    max: number;
    /** How long a query waits for a free pool connection before failing (instead of hanging). */
    connectionTimeoutMs: number;
  };
  redisUrl: string;
  queueDriver: 'bullmq' | 'inline';
  queue: {
    /** Producer: an enqueue that cannot reach Redis within this budget fails (503 QUEUE_UNAVAILABLE). */
    enqueueTimeoutMs: number;
    /** BullMQ job lock duration: how long a worker may lose Redis before its job counts as stalled. */
    jobLockMs: number;
  };
  corsOrigins: string[];
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  ai: {
    provider: 'mock' | 'anthropic';
    anthropic: AnthropicConfig;
  };
  director: {
    maxRepairAttempts: number;
    /** Minimum overall run timeout; the effective timeout scales with the plan (see `effectiveRunTimeoutMs`). */
    runTimeoutMs: number;
    /** Per-step budget used to scale the run timeout for long plans (0 disables scaling). */
    stepTimeoutMs: number;
    cacheEnabled: boolean;
    pricingOverrides: Record<string, ModelPricingConfig> | null;
    workerConcurrency: number;
    /** A RUNNING run whose heartbeat is older than this is reaped as WORKER_LOST. */
    heartbeatStaleMs: number;
    /** A QUEUED run older than this whose queue job is gone is reaped as QUEUE_LOST. */
    queuedStaleMs: number;
    /** How often the stale-run reaper runs (0 disables it). */
    reaperIntervalMs: number;
  };
  limits: ResourceLimits;
  quotas: {
    directorRunsPerDay: number;
    directorUsdPerDay: number;
    /** Queued + running director runs per user (across projects). */
    activeRunsPerUser: number;
  };
  /** Requests per minute per authenticated user. */
  rateLimitPerMinute: number;
  /** Failed authentications per minute per client IP before /v1 answers 429 without touching the database. */
  rateLimitUnauthPerMinute: number;
  /** Byte budget of the in-process cache of serialized version DTOs (0 disables it). */
  versionCacheMaxBytes: number;
  dev: {
    userEmail: string;
    apiToken: string | undefined;
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid studio-api configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const posInt = (def: number) => z.coerce.number().int().positive().default(def);
const nonNegInt = (def: number) => z.coerce.number().int().min(0).default(def);
/** A millisecond duration that is used as a timer delay (bounded by MAX_TIMER_MS). */
const timerMs = (def: number, min: number) => z.coerce.number().int().min(min).max(MAX_TIMER_MS).default(def);

const ModelPricingSchema = z
  .object({
    inputPerMTok: z.number().min(0),
    outputPerMTok: z.number().min(0),
    cacheReadPerMTok: z.number().min(0),
    cacheWritePerMTok: z.number().min(0),
  })
  .strict();

const PricingOverridesSchema = z.record(z.string().min(1), ModelPricingSchema);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    STUDIO_API_HOST: z.string().min(1).default('0.0.0.0'),
    STUDIO_API_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required' })
      .min(1)
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
    REDIS_URL: z
      .string()
      .min(1)
      .refine((v) => /^rediss?:\/\//.test(v), 'REDIS_URL must be a redis:// or rediss:// URL')
      .default('redis://localhost:6379'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(1000).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: timerMs(5_000, 100),
    QUEUE_DRIVER: z.enum(['bullmq', 'inline']).default('bullmq'),
    QUEUE_ENQUEUE_TIMEOUT_MS: timerMs(3_000, 50),
    DIRECTOR_JOB_LOCK_MS: timerMs(300_000, 30_000),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).max(128).default('claude-opus-5-5'),
    ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    ANTHROPIC_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(16000).default(16000),
    ANTHROPIC_FALLBACKS: z.enum(['default', 'off']).default('default'),
    ANTHROPIC_STRUCTURED_OUTPUT: z.enum(['json_schema', 'prompt']).default('json_schema'),

    DIRECTOR_MAX_REPAIR_ATTEMPTS: nonNegInt(2),
    DIRECTOR_RUN_TIMEOUT_MS: timerMs(1_800_000, 1),
    DIRECTOR_STEP_TIMEOUT_MS: timerMs(120_000, 0),
    DIRECTOR_CACHE: z.enum(['on', 'off']).default('on'),
    DIRECTOR_PRICING_JSON: z.string().min(1).optional(),
    DIRECTOR_WORKER_CONCURRENCY: posInt(2),
    DIRECTOR_HEARTBEAT_STALE_MS: timerMs(60_000, 5_000),
    DIRECTOR_QUEUED_STALE_MS: timerMs(600_000, 10_000),
    DIRECTOR_REAPER_INTERVAL_MS: timerMs(30_000, 0),

    LIMIT_MAX_DURATION_SECONDS: posInt(DEFAULT_RESOURCE_LIMITS.maxDurationSeconds),
    LIMIT_MAX_WIDTH: posInt(DEFAULT_RESOURCE_LIMITS.maxWidth),
    LIMIT_MAX_HEIGHT: posInt(DEFAULT_RESOURCE_LIMITS.maxHeight),
    LIMIT_MAX_FPS: posInt(DEFAULT_RESOURCE_LIMITS.maxFps),
    LIMIT_MAX_SCENES: posInt(DEFAULT_RESOURCE_LIMITS.maxScenes),
    LIMIT_MAX_CHAPTERS: posInt(DEFAULT_RESOURCE_LIMITS.maxChapters),
    LIMIT_MAX_TRACKS: posInt(DEFAULT_RESOURCE_LIMITS.maxTracks),
    LIMIT_MAX_ASSETS: posInt(DEFAULT_RESOURCE_LIMITS.maxAssets),
    LIMIT_MAX_PROMPT_CHARS: posInt(DEFAULT_RESOURCE_LIMITS.maxPromptChars),
    LIMIT_DIRECTOR_RUNS_PER_DAY: nonNegInt(50),
    LIMIT_DIRECTOR_USD_PER_DAY: z.coerce.number().min(0).default(25),
    LIMIT_ACTIVE_RUNS_PER_USER: posInt(2),
    RATE_LIMIT_PER_MINUTE: posInt(300),
    RATE_LIMIT_UNAUTH_PER_MINUTE: posInt(60),
    VERSION_CACHE_MAX_BYTES: nonNegInt(64 * 1024 * 1024),

    // Loose check on purpose: the default `dev@localhost` has no TLD.
    STUDIO_DEV_USER_EMAIL: z
      .string()
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+$/, 'STUDIO_DEV_USER_EMAIL must look like an email address')
      .default('dev@localhost'),
    STUDIO_DEV_API_TOKEN: z.string().min(32, 'STUDIO_DEV_API_TOKEN must be at least 32 characters').optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
      });
    }
    if (env.DIRECTOR_REAPER_INTERVAL_MS !== 0 && env.DIRECTOR_REAPER_INTERVAL_MS < 1_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['DIRECTOR_REAPER_INTERVAL_MS'],
        message: 'DIRECTOR_REAPER_INTERVAL_MS must be 0 (disabled) or at least 1000',
      });
    }
  });

type EnvInput = Record<string, string | undefined>;

/** Empty strings in env files mean "unset". */
function normalizeEnv(env: EnvInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed !== '') out[key] = trimmed;
  }
  return out;
}

function parsePricing(raw: string | undefined, issues: string[]): Record<string, ModelPricingConfig> | null {
  if (raw === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    issues.push('DIRECTOR_PRICING_JSON: must be valid JSON');
    return null;
  }
  const parsed = PricingOverridesSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`DIRECTOR_PRICING_JSON.${issue.path.join('.')}: ${issue.message}`);
    }
    return null;
  }
  return parsed.data;
}

/** Parses and validates the environment. Error messages name variables but never echo their values. */
export function loadConfig(env: EnvInput = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(normalizeEnv(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const issues: string[] = [];
  const pricingOverrides = parsePricing(e.DIRECTOR_PRICING_JSON, issues);
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    nodeEnv: e.NODE_ENV,
    host: e.STUDIO_API_HOST,
    port: e.STUDIO_API_PORT,
    databaseUrl: e.DATABASE_URL,
    databasePool: { max: e.DATABASE_POOL_MAX, connectionTimeoutMs: e.DATABASE_CONNECTION_TIMEOUT_MS },
    redisUrl: e.REDIS_URL,
    queueDriver: e.QUEUE_DRIVER,
    queue: { enqueueTimeoutMs: e.QUEUE_ENQUEUE_TIMEOUT_MS, jobLockMs: e.DIRECTOR_JOB_LOCK_MS },
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    logLevel: e.LOG_LEVEL,
    ai: {
      provider: e.AI_PROVIDER,
      anthropic: {
        apiKey: e.ANTHROPIC_API_KEY,
        model: e.ANTHROPIC_MODEL,
        effort: e.ANTHROPIC_EFFORT,
        maxOutputTokens: e.ANTHROPIC_MAX_OUTPUT_TOKENS,
        fallbacks: e.ANTHROPIC_FALLBACKS,
        structuredOutput: e.ANTHROPIC_STRUCTURED_OUTPUT,
      },
    },
    director: {
      maxRepairAttempts: e.DIRECTOR_MAX_REPAIR_ATTEMPTS,
      runTimeoutMs: e.DIRECTOR_RUN_TIMEOUT_MS,
      stepTimeoutMs: e.DIRECTOR_STEP_TIMEOUT_MS,
      cacheEnabled: e.DIRECTOR_CACHE === 'on',
      pricingOverrides,
      workerConcurrency: e.DIRECTOR_WORKER_CONCURRENCY,
      heartbeatStaleMs: e.DIRECTOR_HEARTBEAT_STALE_MS,
      queuedStaleMs: e.DIRECTOR_QUEUED_STALE_MS,
      reaperIntervalMs: e.DIRECTOR_REAPER_INTERVAL_MS,
    },
    limits: {
      maxDurationSeconds: e.LIMIT_MAX_DURATION_SECONDS,
      maxWidth: e.LIMIT_MAX_WIDTH,
      maxHeight: e.LIMIT_MAX_HEIGHT,
      maxFps: e.LIMIT_MAX_FPS,
      maxScenes: e.LIMIT_MAX_SCENES,
      maxChapters: e.LIMIT_MAX_CHAPTERS,
      maxTracks: e.LIMIT_MAX_TRACKS,
      maxAssets: e.LIMIT_MAX_ASSETS,
      maxPromptChars: e.LIMIT_MAX_PROMPT_CHARS,
    },
    quotas: {
      directorRunsPerDay: e.LIMIT_DIRECTOR_RUNS_PER_DAY,
      directorUsdPerDay: e.LIMIT_DIRECTOR_USD_PER_DAY,
      activeRunsPerUser: e.LIMIT_ACTIVE_RUNS_PER_USER,
    },
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    rateLimitUnauthPerMinute: e.RATE_LIMIT_UNAUTH_PER_MINUTE,
    versionCacheMaxBytes: e.VERSION_CACHE_MAX_BYTES,
    dev: {
      userEmail: e.STUDIO_DEV_USER_EMAIL,
      apiToken: e.STUDIO_DEV_API_TOKEN,
    },
  };
}

/**
 * Effective wall-clock budget of one director run: the configured minimum, scaled up for long plans
 * (`2 + 5 × chapters + 1` sequential steps) so multi-hour videos with a live provider are not cut off.
 * Clamped to MAX_TIMER_MS (a larger `setTimeout` delay would fire immediately).
 */
export function effectiveRunTimeoutMs(config: Pick<AppConfig, 'director'>, totalSteps: number): number {
  const scaled = Math.max(0, Math.floor(totalSteps)) * config.director.stepTimeoutMs;
  return Math.min(MAX_TIMER_MS, Math.max(config.director.runTimeoutMs, scaled));
}
