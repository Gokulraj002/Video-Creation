import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, type TemplateRow } from '@vc/core';
import { HttpError } from '../http';

export const templatesRouter = Router();

const templateInput = z.object({
  name: z.string().min(1),
  compositionId: z.string().min(1),
  props: z.record(z.unknown()).default({}),
  baseVideoUrl: z.string().url().nullable().optional(),
  baseVideoFit: z.enum(['pad', 'crop']).default('pad'),
  waTemplateName: z.string().min(1).nullable().optional(),
  waTemplateLang: z.string().min(2).default('en'),
  waBodyParams: z.array(z.string().min(1)).default([]),
});

templatesRouter.get('/templates', async (_req, res) => {
  res.json(await query<TemplateRow>('SELECT * FROM templates ORDER BY created_at'));
});

templatesRouter.post('/templates', async (req, res) => {
  const t = templateInput.parse(req.body);
  const row = await queryOne<TemplateRow>(
    `INSERT INTO templates (name, composition_id, props, base_video_url, base_video_fit, wa_template_name,
                            wa_template_lang, wa_body_params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [t.name, t.compositionId, t.props, t.baseVideoUrl ?? null, t.baseVideoFit, t.waTemplateName ?? null,
      t.waTemplateLang, JSON.stringify(t.waBodyParams)],
  );
  res.status(201).json(row);
});

templatesRouter.patch('/templates/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  // partial() skips defaults, so omitted fields stay undefined and keep their current value
  const t = templateInput.partial().parse(req.body);
  const row = await queryOne<TemplateRow>(
    `UPDATE templates SET
       name = COALESCE($2, name),
       composition_id = COALESCE($3, composition_id),
       props = COALESCE($4, props),
       base_video_url = CASE WHEN $5::boolean THEN $6 ELSE base_video_url END,
       wa_template_name = CASE WHEN $7::boolean THEN $8 ELSE wa_template_name END,
       wa_template_lang = COALESCE($9, wa_template_lang),
       wa_body_params = COALESCE($10, wa_body_params),
       base_video_fit = COALESCE($11, base_video_fit)
     WHERE id = $1 RETURNING *`,
    [id, t.name ?? null, t.compositionId ?? null, t.props ?? null,
      t.baseVideoUrl !== undefined, t.baseVideoUrl ?? null,
      t.waTemplateName !== undefined, t.waTemplateName ?? null,
      t.waTemplateLang ?? null, t.waBodyParams ? JSON.stringify(t.waBodyParams) : null, t.baseVideoFit ?? null],
  );
  if (!row) throw new HttpError(404, 'template not found');
  res.json(row);
});
