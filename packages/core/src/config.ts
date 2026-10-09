import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const optional = z.string().optional();

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/video_creation'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  API_PORT: z.coerce.number().int().default(4000),
  ADMIN_API_KEY: z.string().min(1).default('change-me'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).default('91'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default(path.join(ROOT_DIR, 'storage')),
  S3_BUCKET: optional,
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_PUBLIC_URL: optional,

  RENDER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  CHROME_EXECUTABLE: optional,
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_VOICE_ID: optional,
  ELEVENLABS_MODEL_ID: z.string().default('eleven_multilingual_v2'),

  WHATSAPP_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_VERIFY_TOKEN: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_SEND_RATE_PER_SEC: z.coerce.number().int().positive().default(20),
});

// Treat `KEY=` in .env as unset so defaults and optional() apply
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));

export const config = schema.parse(env);
export type Config = typeof config;

if (config.NODE_ENV === 'production' && config.ADMIN_API_KEY === 'change-me') {
  throw new Error('Set ADMIN_API_KEY before running in production');
}

if (config.STORAGE_DRIVER === 's3' && (!config.S3_BUCKET || !config.S3_PUBLIC_URL)) {
  throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET and S3_PUBLIC_URL');
}
