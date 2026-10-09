const KEY_STORAGE = 'vc_api_key';

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setApiKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // private mode: the key just won't be remembered
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Authorization', `Bearer ${getApiKey()}`);
  let body = rest.body;
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  const res = await fetch(`/api${path}`, { ...rest, headers, body });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export interface Template {
  id: string;
  name: string;
  composition_id: string;
  props: Record<string, unknown>;
  base_video_url: string | null;
  wa_template_name: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  template_id: string;
  template_name: string;
  props: Record<string, unknown>;
  created_at: string;
  contacts: number;
  renders: Record<'queued' | 'rendering' | 'done' | 'failed', number>;
  messages: Record<'queued' | 'dry_run' | 'sent' | 'delivered' | 'read' | 'failed', number>;
}

export interface ContactItem {
  id: string;
  name: string | null;
  phone: string;
  vars: Record<string, string>;
  render_status: string | null;
  video_url: string | null;
  render_error: string | null;
  render_ms: number | null;
  message_status: string | null;
  message_error: string | null;
}
