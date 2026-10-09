import cors from 'cors';
import express from 'express';
import { config } from '@vc/core';
import { errorHandler, requireApiKey } from './http';
import { campaignsRouter } from './routes/campaigns';
import { templatesRouter } from './routes/templates';
import { webhooksRouter } from './routes/webhooks';

const app = express();
app.disable('x-powered-by');
app.use(cors());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Mounted before the JSON parser: signature checks need the raw body
app.use('/webhooks', webhooksRouter);

if (config.STORAGE_DRIVER === 'local') {
  app.use('/media', express.static(config.STORAGE_DIR, { maxAge: '1h' }));
}

app.use('/api', express.json({ limit: '1mb' }), requireApiKey, templatesRouter, campaignsRouter);
app.use(errorHandler);

app.listen(config.API_PORT, () => {
  console.log(`API listening on http://localhost:${config.API_PORT}`);
});
