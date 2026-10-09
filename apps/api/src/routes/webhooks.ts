import express, { Router } from 'express';
import { config, query, verifyWebhookSignature } from '@vc/core';

export const webhooksRouter = Router();

// Meta calls this once when you register the webhook URL
webhooksRouter.get('/whatsapp', (req, res) => {
  const token = config.WHATSAPP_VERIFY_TOKEN;
  if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
    res.send(String(req.query['hub.challenge'] ?? ''));
  } else {
    res.sendStatus(403);
  }
});

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

interface StatusPayload {
  entry?: {
    changes?: {
      value?: { statuses?: { id: string; status: string; errors?: { title?: string; message?: string }[] }[] };
    }[];
  }[];
}

webhooksRouter.post('/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyWebhookSignature(raw, req.get('x-hub-signature-256'))) {
    res.sendStatus(401);
    return;
  }

  let payload: StatusPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as StatusPayload;
  } catch {
    res.sendStatus(400);
    return;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        if (!STATUSES.has(s.status)) continue;
        const error = s.errors?.[0] ? (s.errors[0].message ?? s.errors[0].title ?? null) : null;
        // Statuses can arrive out of order: only move forward (failed always wins)
        await query(
          `UPDATE messages SET status = $2::message_status, error = COALESCE($3, error), updated_at = now()
            WHERE wa_message_id = $1
              AND ($2 = 'failed' OR array_position(ARRAY['queued','dry_run','sent','delivered','read']::message_status[], status)
                                   < array_position(ARRAY['queued','dry_run','sent','delivered','read']::message_status[], $2::message_status))`,
          [s.id, s.status, error],
        );
      }
    }
  }
  res.sendStatus(200);
});
