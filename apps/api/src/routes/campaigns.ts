import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config, getRenderQueue, getSendQueue, parseContactsCsv, query, queryOne } from '@vc/core';
import { HttpError } from '../http';

export const campaignsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uuid = z.string().uuid();

const STATS_SQL = `
  SELECT ca.id, ca.name, ca.template_id, ca.props, ca.created_at, t.name AS template_name,
         count(c.id)::int AS contacts,
         count(r.id) FILTER (WHERE r.status = 'queued')::int    AS r_queued,
         count(r.id) FILTER (WHERE r.status = 'rendering')::int AS r_rendering,
         count(r.id) FILTER (WHERE r.status = 'done')::int      AS r_done,
         count(r.id) FILTER (WHERE r.status = 'failed')::int    AS r_failed,
         count(m.id) FILTER (WHERE m.status = 'queued')::int    AS m_queued,
         count(m.id) FILTER (WHERE m.status = 'dry_run')::int   AS m_dry_run,
         count(m.id) FILTER (WHERE m.status = 'sent')::int      AS m_sent,
         count(m.id) FILTER (WHERE m.status = 'delivered')::int AS m_delivered,
         count(m.id) FILTER (WHERE m.status = 'read')::int      AS m_read,
         count(m.id) FILTER (WHERE m.status = 'failed')::int    AS m_failed
    FROM campaigns ca
    JOIN templates t ON t.id = ca.template_id
    LEFT JOIN contacts c ON c.campaign_id = ca.id
    LEFT JOIN renders r ON r.contact_id = c.id
    LEFT JOIN messages m ON m.contact_id = c.id`;

type StatsRow = Record<string, unknown> & { [k: `${'r' | 'm'}_${string}`]: number };

function shapeStats(row: StatsRow) {
  const out: Record<string, unknown> = {};
  const renders: Record<string, number> = {};
  const messages: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('r_')) renders[k.slice(2)] = v as number;
    else if (k.startsWith('m_')) messages[k.slice(2)] = v as number;
    else out[k] = v;
  }
  return { ...out, renders, messages };
}

async function getCampaign(id: string) {
  const row = await queryOne<StatsRow>(`${STATS_SQL} WHERE ca.id = $1 GROUP BY ca.id, t.name`, [id]);
  if (!row) throw new HttpError(404, 'campaign not found');
  return shapeStats(row);
}

campaignsRouter.get('/campaigns', async (_req, res) => {
  const rows = await query<StatsRow>(`${STATS_SQL} GROUP BY ca.id, t.name ORDER BY ca.created_at DESC`);
  res.json(rows.map(shapeStats));
});

campaignsRouter.post('/campaigns', async (req, res) => {
  const body = z
    .object({ name: z.string().min(1), templateId: uuid, props: z.record(z.unknown()).default({}) })
    .parse(req.body);
  const template = await queryOne('SELECT id FROM templates WHERE id = $1', [body.templateId]);
  if (!template) throw new HttpError(400, 'template not found');
  const row = await queryOne<{ id: string }>(
    'INSERT INTO campaigns (name, template_id, props) VALUES ($1, $2, $3) RETURNING id',
    [body.name, body.templateId, body.props],
  );
  res.status(201).json(await getCampaign(row!.id));
});

campaignsRouter.get('/campaigns/:id', async (req, res) => {
  res.json(await getCampaign(uuid.parse(req.params.id)));
});

campaignsRouter.get('/campaigns/:id/contacts', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { limit, offset } = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(req.query);

  const [rows, total] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.phone, c.vars,
              r.status AS render_status, r.video_url, r.error AS render_error, r.render_ms,
              m.status AS message_status, m.error AS message_error
         FROM contacts c
         LEFT JOIN renders r ON r.contact_id = c.id
         LEFT JOIN messages m ON m.contact_id = c.id
        WHERE c.campaign_id = $1
        ORDER BY c.seq
        LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    ),
    queryOne<{ count: number }>('SELECT count(*)::int AS count FROM contacts WHERE campaign_id = $1', [id]),
  ]);
  res.json({ total: total?.count ?? 0, items: rows });
});

campaignsRouter.post('/campaigns/:id/contacts', upload.single('file'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  await getCampaign(id);
  if (!req.file) throw new HttpError(400, 'upload a CSV as multipart field "file"');

  const { contacts, invalid } = parseContactsCsv(req.file.buffer, config.DEFAULT_COUNTRY_CODE);
  const inserted = contacts.length
    ? await query(
        `INSERT INTO contacts (campaign_id, name, phone, vars)
         SELECT $1, x.name, x.phone, x.vars FROM jsonb_to_recordset($2::jsonb) AS x(name text, phone text, vars jsonb)
         ON CONFLICT (campaign_id, phone) DO NOTHING
         RETURNING id`,
        [id, JSON.stringify(contacts)],
      )
    : [];

  res.json({
    inserted: inserted.length,
    alreadyInCampaign: contacts.length - inserted.length,
    invalid,
  });
});

campaignsRouter.post('/campaigns/:id/render', async (req, res) => {
  const id = uuid.parse(req.params.id);
  // limit: render a few previews first; force: re-render finished videos after a template change
  const { limit, force } = z
    .object({ limit: z.number().int().positive().optional(), force: z.boolean().default(false) })
    .parse(req.body ?? {});
  await getCampaign(id);

  const rows = await query<{ id: string }>(
    `WITH targets AS (
       SELECT c.id FROM contacts c
       LEFT JOIN renders r ON r.contact_id = c.id
       WHERE c.campaign_id = $1
         AND (r.id IS NULL OR r.status = 'failed' OR ($3 AND r.status = 'done'))
       ORDER BY c.seq
       LIMIT $2
     )
     INSERT INTO renders (contact_id) SELECT id FROM targets
     ON CONFLICT (contact_id) DO UPDATE
       SET status = 'queued', error = NULL, video_url = NULL, render_ms = NULL, updated_at = now()
     RETURNING id`,
    [id, limit ?? null, force],
  );

  await getRenderQueue().addBulk(rows.map((r) => ({ name: 'render', data: { renderId: r.id } })));
  res.json({ queued: rows.length });
});

campaignsRouter.post('/campaigns/:id/send', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { retryFailed } = z.object({ retryFailed: z.boolean().default(false) }).parse(req.body ?? {});
  await getCampaign(id);

  // Each contact gets at most one message row, so pressing "send" twice never double-sends
  const fresh = await query<{ id: string }>(
    `INSERT INTO messages (contact_id)
     SELECT c.id FROM contacts c JOIN renders r ON r.contact_id = c.id
      WHERE c.campaign_id = $1 AND r.status = 'done'
     ON CONFLICT (contact_id) DO NOTHING
     RETURNING id`,
    [id],
  );
  const retried = retryFailed
    ? await query<{ id: string }>(
        `UPDATE messages m SET status = 'queued', error = NULL, updated_at = now()
           FROM contacts c
          WHERE c.id = m.contact_id AND c.campaign_id = $1 AND m.status = 'failed'
          RETURNING m.id`,
        [id],
      )
    : [];

  const ids = [...fresh, ...retried].map((r) => r.id);
  await getSendQueue().addBulk(ids.map((messageId) => ({ name: 'send', data: { messageId } })));
  res.json({ queued: ids.length });
});
