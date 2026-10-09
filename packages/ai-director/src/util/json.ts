import { createHash } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted recursively (stable across runs and key insertion order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * JSON for embedding inside XML-ish prompt tags: `<` and `>` are escaped as `\u003c` / `\u003e` (still valid JSON),
 * so untrusted data can never close a tag such as `</user_request>`.
 */
export function promptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Escapes free text for embedding inside prompt tags. */
export function promptText(value: string): string {
  return value.replace(/</g, '‹').replace(/>/g, '›');
}

/** Removes optional ```json fences around a model response. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseJsonText(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(stripCodeFences(text)) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}
