import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '@vc/core';

// Every segment is encoded with identical settings so segments can be joined with
// `-c copy` (no re-encode). That is what keeps a long shared base video cheap:
// it is encoded once per template, and each contact only pays for the short intro.
export type Fit = 'pad' | 'crop';

const VIDEO_FILTERS: Record<Fit, string> = {
  // Letterbox: keeps the whole frame, adds black bars (safe for slides / text-heavy footage)
  pad: 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
  // Center crop: fills the screen, cuts the sides (best for people / talking-head footage)
  crop: 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
};
// TTS output levels vary a lot; -16 LUFS is the usual target for phone/social playback
const VOICE_LOUDNESS = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const ENCODE_ARGS = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-g', '60', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart',
];

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr}`)),
    );
  });
}

export async function probe(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const out = await run(config.FFPROBE_PATH, [
    '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file,
  ]);
  const json = JSON.parse(out) as { streams?: { codec_type: string }[]; format?: { duration?: string } };
  return {
    duration: Number(json.format?.duration ?? 0),
    hasAudio: Boolean(json.streams?.some((s) => s.codec_type === 'audio')),
  };
}

export interface NormalizeOptions {
  fit?: Fit;
  /** Replaces the audio track with this voice-over */
  voice?: string;
  /** Background music, looped to the video length and ducked under the voice */
  music?: string;
  musicVolume?: number;
}

/** Re-encodes to the shared 1080x1920/30fps/AAC format, optionally adding voice-over and music. */
export async function normalize(input: string, output: string, opts: NormalizeOptions = {}): Promise<void> {
  const { fit = 'pad', voice, music, musicVolume = 0.25 } = opts;
  const source = await probe(input);
  if (!(source.duration > 0)) throw new Error(`could not read duration of ${input}`);
  const args = ['-y', '-i', input];
  const filters = [`[0:v]${VIDEO_FILTERS[fit]},setsar=1,fps=30[v]`];
  let audioOut = '[a]';

  if (voice) args.push('-i', voice);
  if (music) args.push('-stream_loop', '-1', '-i', music);
  const musicIdx = voice ? 2 : 1;

  if (voice && music) {
    // The voice keys a compressor on the music (sidechain ducking), then both are mixed.
    // apad keeps the voice "running" silently so music continues after the voice ends;
    // normalize=0 stops amix from halving the voice volume.
    filters.push(
      `[1:a]${VOICE_LOUDNESS},apad,asplit=2[sc][vo]`,
      `[${musicIdx}:a]volume=${musicVolume}[m]`,
      '[m][sc]sidechaincompress=threshold=0.02:ratio=20:attack=20:release=300[duck]',
      '[duck][vo]amix=inputs=2:duration=first:normalize=0[a]',
    );
  } else if (voice) {
    filters.push(`[1:a]${VOICE_LOUDNESS},apad[a]`);
  } else if (music) {
    filters.push(`[${musicIdx}:a]volume=${musicVolume}[a]`);
  } else if (source.hasAudio) {
    audioOut = '0:a:0';
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    audioOut = '1:a:0';
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', audioOut);
  // Looped music / padded voice / anullsrc are endless. Cut at the video's length:
  // -shortest stalls when the endless stream goes through a filter graph.
  args.push('-t', source.duration.toFixed(3));
  args.push(...ENCODE_ARGS, output);
  await run(config.FFMPEG_PATH, args);
}

/**
 * Joins normalized segments without re-encoding. Only safe because every segment went
 * through normalize(): concat with -c copy on mismatched clips "succeeds" but produces
 * a broken file.
 */
export async function concat(parts: string[], output: string, workDir: string): Promise<void> {
  const list = path.join(workDir, 'concat.txt');
  await fs.writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await run(config.FFMPEG_PATH, [
    '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output,
  ]);
}

const baseCacheDir = path.join(os.tmpdir(), 'vc-base-cache');
const inflight = new Map<string, Promise<string>>();

/** Downloads + normalizes a template's base video once and caches it on disk. */
export function getNormalizedBase(url: string, fit: Fit): Promise<string> {
  const key = crypto.createHash('sha1').update(`${fit}:${url}`).digest('hex');
  const dest = path.join(baseCacheDir, `${key}.mp4`);

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const exists = await fs.stat(dest).then(() => true, () => false);
      if (exists) return dest;
      await fs.mkdir(baseCacheDir, { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp.mp4`;
      await normalize(url, tmp, { fit });
      await fs.rename(tmp, dest);
      return dest;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
