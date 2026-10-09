/** Timeline document migrations (version N -> N + 1). */

export const CURRENT_TIMELINE_VERSION = 1;

export type TimelineDocument = Record<string, unknown>;
export type TimelineMigration = (doc: TimelineDocument) => TimelineDocument;
export type TimelineMigrations = Readonly<Record<number, TimelineMigration>>;

/** Registry of migrations keyed by SOURCE version. Empty in v1. */
export const TIMELINE_MIGRATIONS: TimelineMigrations = Object.freeze({});

export type TimelineMigrationErrorCode =
  | 'INVALID_DOCUMENT'
  | 'MISSING_VERSION'
  | 'INVALID_VERSION'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_MIGRATION'
  | 'MIGRATION_FAILED';

export class TimelineMigrationError extends Error {
  readonly code: TimelineMigrationErrorCode;
  readonly version: number | null;

  constructor(code: TimelineMigrationErrorCode, message: string, version: number | null = null) {
    super(message);
    this.name = 'TimelineMigrationError';
    this.code = code;
    this.version = version;
  }
}

function isPlainObject(value: unknown): value is TimelineDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `schemaVersion` (missing → error), applies migrations sequentially up to `targetVersion`
 * and rejects versions newer than `targetVersion`. Returns the (unvalidated) migrated document.
 */
export function migrateTimeline(
  input: unknown,
  migrations: TimelineMigrations = TIMELINE_MIGRATIONS,
  targetVersion: number = CURRENT_TIMELINE_VERSION,
): TimelineDocument {
  if (!isPlainObject(input)) {
    throw new TimelineMigrationError('INVALID_DOCUMENT', 'Timeline must be a JSON object');
  }
  if (!('schemaVersion' in input) || input.schemaVersion === undefined) {
    throw new TimelineMigrationError('MISSING_VERSION', 'Timeline is missing "schemaVersion"');
  }
  const version = input.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new TimelineMigrationError('INVALID_VERSION', `Invalid timeline schemaVersion: ${JSON.stringify(version)}`);
  }
  if (version > targetVersion) {
    throw new TimelineMigrationError(
      'UNSUPPORTED_VERSION',
      `Timeline schemaVersion ${version} is newer than the supported version ${targetVersion}`,
      version,
    );
  }
  let doc: TimelineDocument = input;
  for (let v = version; v < targetVersion; v++) {
    const migrate = migrations[v];
    if (!migrate) {
      throw new TimelineMigrationError('MISSING_MIGRATION', `No timeline migration from version ${v} to ${v + 1}`, v);
    }
    const next: unknown = migrate(doc);
    if (!isPlainObject(next) || next.schemaVersion !== v + 1) {
      throw new TimelineMigrationError(
        'MIGRATION_FAILED',
        `Timeline migration ${v} -> ${v + 1} must return an object with schemaVersion ${v + 1}`,
        v,
      );
    }
    doc = next;
  }
  return doc;
}
