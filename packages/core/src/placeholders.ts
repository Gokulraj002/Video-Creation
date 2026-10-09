import type { Vars } from './types';

const PLACEHOLDER = /\{(\w+)(?:\|([^}]*))?\}/g;

/** Replaces `{var}` and `{var|fallback}` in a string. Missing vars use the fallback or "". */
export function fillString(input: string, vars: Vars): string {
  return input.replace(PLACEHOLDER, (_, key: string, fallback?: string) => {
    const value = vars[key]?.trim();
    return value ? value : (fallback ?? '');
  });
}

/** Applies fillString to every string value (one level deep is all templates need). */
export function fillProps(props: Record<string, unknown>, vars: Vars): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === 'string' ? fillString(v, vars) : v]),
  );
}
