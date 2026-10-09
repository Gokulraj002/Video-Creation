import crypto from 'node:crypto';
import { config } from './config';

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface SendVideoTemplateInput {
  to: string;
  templateName: string;
  language: string;
  videoUrl: string;
  bodyParams: string[];
}

export function whatsappConfigured(): boolean {
  return Boolean(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID);
}

/**
 * Sends an approved template message with a VIDEO header via the WhatsApp Cloud API.
 * Returns the WhatsApp message id (wamid).
 */
export async function sendVideoTemplate(input: SendVideoTemplateInput): Promise<string> {
  const url = `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const components: unknown[] = [
    { type: 'header', parameters: [{ type: 'video', video: { link: input.videoUrl } }] },
  ];
  if (input.bodyParams.length) {
    components.push({
      type: 'body',
      parameters: input.bodyParams.map((text) => ({ type: 'text', text })),
    });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: input.to,
      type: 'template',
      template: { name: input.templateName, language: { code: input.language }, components },
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string };
  };

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new WhatsAppError(body.error?.message ?? `WhatsApp API ${res.status}`, res.status, retryable);
  }

  const id = body.messages?.[0]?.id;
  if (!id) throw new WhatsAppError('WhatsApp API returned no message id', res.status, false);
  return id;
}

/** Verifies the X-Hub-Signature-256 header Meta sends on webhook calls. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.WHATSAPP_APP_SECRET) return true;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const given = signature.slice('sha256='.length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
