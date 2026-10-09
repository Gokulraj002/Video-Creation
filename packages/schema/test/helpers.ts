import { expect } from 'vitest';
import { z } from 'zod';

type SafeResult = { success: true } | { success: false; error: z.ZodError };

/** Paths (joined with '.') of every issue in a failed safeParse result. */
export function issuePaths(result: SafeResult): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.map((p) => String(p)).join('.'));
}

/** Asserts that parsing failed with (at least) one issue at exactly `path`. */
export function expectIssueAt(result: SafeResult, path: (string | number)[], message?: RegExp): void {
  expect(result.success, 'expected parsing to fail').toBe(false);
  if (result.success) return;
  const wanted = path.map((p) => String(p)).join('.');
  const matching = result.error.issues.filter((issue) => issue.path.map((p) => String(p)).join('.') === wanted);
  expect(matching.length, `no issue at "${wanted}"; got: ${JSON.stringify(issuePaths(result))}`).toBeGreaterThan(0);
  if (message) {
    expect(matching.some((issue) => message.test(issue.message)), `messages: ${matching.map((i) => i.message).join(' | ')}`).toBe(
      true,
    );
  }
}

/** Asserts that parsing succeeded (prints the issues otherwise). */
export function expectSuccess(result: SafeResult): void {
  if (!result.success) {
    throw new Error(`expected success, got issues: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
}

export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  $ref?: string;
}

/** Every JSON-Schema object lists ALL its properties as required and is not open to extra keys. */
export function jsonSchemaIssues(node: JsonSchemaNode, path = '#'): string[] {
  const issues: string[] = [];
  if (node.$ref) issues.push(`${path}: $ref (recursion?)`);
  if (node.properties) {
    const keys = Object.keys(node.properties);
    const required = new Set(node.required ?? []);
    for (const k of keys) if (!required.has(k)) issues.push(`${path}.${k}: not required`);
    if (typeof node.additionalProperties === 'object') issues.push(`${path}: additionalProperties schema (record)`);
    if (node.additionalProperties === true) issues.push(`${path}: additionalProperties true`);
    for (const [k, child] of Object.entries(node.properties)) issues.push(...jsonSchemaIssues(child, `${path}.${k}`));
  } else if (node.type === 'object' && node.additionalProperties !== false) {
    issues.push(`${path}: object without properties (record/open object)`);
  }
  if (node.items) issues.push(...jsonSchemaIssues(node.items, `${path}[]`));
  for (const [i, child] of (node.anyOf ?? []).entries()) issues.push(...jsonSchemaIssues(child, `${path}|${i}`));
  for (const [i, child] of (node.oneOf ?? []).entries()) issues.push(...jsonSchemaIssues(child, `${path}|${i}`));
  return issues;
}

export function toJsonSchema(schema: z.core.$ZodType): JsonSchemaNode {
  return z.toJSONSchema(schema, { io: 'output' }) as JsonSchemaNode;
}
