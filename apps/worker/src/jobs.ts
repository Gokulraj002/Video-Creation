import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  fillProps,
  fillString,
  query,
  queryOne,
  saveFile,
  sendVideoTemplate,
  WhatsAppError,
  whatsappConfigured,
  type RenderJobData,
  type SendJobData,
  type Vars,
} from '@vc/core';
import { concat, getNormalizedBase, normalize, probe, type Fit } from './ffmpeg';
import { renderComposition } from './remotion';
import { synthesize, ttsConfigured } from './tts';

const MIN_INTRO_SECONDS = 4;
// WhatsApp Cloud API rejects video media above 16 MB
const WHATSAPP_MAX_VIDEO_BYTES = 16 * 1024 * 1024;

function isLastAttempt(job: Job, err?: unknown): boolean {
  return err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}

interface RenderContext {
  campaign_id: string;
  name: string | null;
  vars: Vars;
  composition_id: string;
  template_props: Record<string, unknown>;
  campaign_props: Record<string, unknown>;
  base_video_url: string | null;
  base_video_fit: Fit;
}

export async function processRender(job: Job<RenderJobData>): Promise<void> {
  const { renderId } = job.data;
  const ctx = await queryOne<RenderContext>(
    `SELECT c.campaign_id, c.name, c.vars, t.composition_id, t.props AS template_props,
            ca.props AS campaign_props, t.base_video_url, t.base_video_fit
       FROM renders r
       JOIN contacts c ON c.id = r.contact_id
       JOIN campaigns ca ON ca.id = c.campaign_id
       JOIN templates t ON t.id = ca.template_id
      WHERE r.id = $1`,
    [renderId],
  );
  if (!ctx) return; // contact or campaign was deleted

  await query(`UPDATE renders SET status = 'rendering', error = NULL, updated_at = now() WHERE id = $1`, [renderId]);
  const startedAt = Date.now();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vc-render-'));

  try {
    const vars: Vars = { ...ctx.vars, name: ctx.name ?? '' };
    // voiceText / musicUrl / musicVolume drive the audio mix; the rest goes to the Remotion composition
    const { voiceText, musicUrl, musicVolume, ...props } = fillProps(
      { ...ctx.template_props, ...ctx.campaign_props },
      vars,
    );
    const music = typeof musicUrl === 'string' && musicUrl.trim() ? musicUrl.trim() : undefined;

    let voice: string | undefined;
    if (typeof voiceText === 'string' && voiceText.trim() && ttsConfigured()) {
      voice = path.join(workDir, 'voice.mp3');
      await synthesize(voiceText, voice);
      const { duration } = await probe(voice);
      props.durationInSeconds = Math.max(MIN_INTRO_SECONDS, Math.ceil((duration + 0.6) * 10) / 10);
    }

    const raw = path.join(workDir, 'raw.mp4');
    await renderComposition(ctx.composition_id, props, raw);

    let output = raw;
    if (voice || music || ctx.base_video_url) {
      const intro = path.join(workDir, 'intro.mp4');
      await normalize(raw, intro, {
        voice,
        music,
        musicVolume: typeof musicVolume === 'number' ? musicVolume : undefined,
      });
      output = intro;
      if (ctx.base_video_url) {
        const base = await getNormalizedBase(ctx.base_video_url, ctx.base_video_fit);
        output = path.join(workDir, 'final.mp4');
        await concat([intro, base], output, workDir);
      }
    }

    const { size } = await fs.stat(output);
    if (size > WHATSAPP_MAX_VIDEO_BYTES) {
      throw new UnrecoverableError(
        `video is ${(size / 1024 / 1024).toFixed(1)} MB; WhatsApp allows 16 MB. Shorten the base video.`,
      );
    }

    const url = await saveFile(output, `renders/${ctx.campaign_id}/${renderId}.mp4`);
    await query(
      `UPDATE renders SET status = 'done', video_url = $2, render_ms = $3, updated_at = now() WHERE id = $1`,
      // Re-renders overwrite the same key, so bust caches with a version param
      [renderId, `${url}?v=${Date.now()}`, Date.now() - startedAt],
    );
  } catch (err) {
    await query(`UPDATE renders SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [
      renderId,
      isLastAttempt(job, err) ? 'failed' : 'queued',
      errorMessage(err),
    ]);
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

interface SendContext {
  status: string;
  phone: string;
  name: string | null;
  vars: Vars;
  render_status: string | null;
  video_url: string | null;
  wa_template_name: string | null;
  wa_template_lang: string;
  wa_body_params: string[];
}

async function markMessage(id: string, status: string, fields: { waId?: string; error?: string } = {}) {
  await query(
    `UPDATE messages SET status = $2, wa_message_id = COALESCE($3, wa_message_id), error = $4, updated_at = now()
      WHERE id = $1`,
    [id, status, fields.waId ?? null, fields.error ?? null],
  );
}

export async function processSend(job: Job<SendJobData>): Promise<void> {
  const { messageId } = job.data;
  const ctx = await queryOne<SendContext>(
    `SELECT m.status, c.phone, c.name, c.vars, r.status AS render_status, r.video_url,
            t.wa_template_name, t.wa_template_lang, t.wa_body_params
       FROM messages m
       JOIN contacts c ON c.id = m.contact_id
       JOIN campaigns ca ON ca.id = c.campaign_id
       JOIN templates t ON t.id = ca.template_id
       LEFT JOIN renders r ON r.contact_id = c.id
      WHERE m.id = $1`,
    [messageId],
  );
  // Only queued messages are sent, so a duplicate job can never double-send
  if (!ctx || ctx.status !== 'queued') return;

  if (ctx.render_status !== 'done' || !ctx.video_url) {
    return markMessage(messageId, 'failed', { error: 'video is not rendered' });
  }
  if (!ctx.wa_template_name) {
    return markMessage(messageId, 'failed', { error: 'template has no WhatsApp template name' });
  }

  const vars: Vars = { ...ctx.vars, name: ctx.name ?? '' };
  // Entries look like "name" or "name|there"; WhatsApp rejects empty params
  const bodyParams = ctx.wa_body_params.map((p) => fillString(`{${p}}`, vars) || '-');

  if (!whatsappConfigured()) {
    console.log(`[dry-run] would send ${ctx.video_url} to ${ctx.phone} params=${JSON.stringify(bodyParams)}`);
    return markMessage(messageId, 'dry_run', { waId: `dryrun-${messageId}` });
  }

  try {
    const waId = await sendVideoTemplate({
      to: ctx.phone,
      templateName: ctx.wa_template_name,
      language: ctx.wa_template_lang,
      videoUrl: ctx.video_url,
      bodyParams,
    });
    await markMessage(messageId, 'sent', { waId });
  } catch (err) {
    const retryable = !(err instanceof WhatsAppError) || err.retryable;
    if (!retryable || isLastAttempt(job)) {
      return markMessage(messageId, 'failed', { error: errorMessage(err) });
    }
    throw err;
  }
}
