import type { Prisma } from '../db';

/**
 * Converts a JSON-serialisable value (validated by Zod upstream) into Prisma's JSON input type.
 * The round trip drops `undefined` properties exactly like the database would.
 */
export function toJsonInput(value: unknown): Prisma.InputJsonValue {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Value is not JSON-serialisable');
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) throw new TypeError('A JSON column value cannot be null here');
  return parsed as Prisma.InputJsonValue;
}
