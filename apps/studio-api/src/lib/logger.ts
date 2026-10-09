/** Minimal structured logger interface (satisfied by Fastify's pino logger and by `createConsoleLogger`). */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVEL_VALUE: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

const SECRET_KEY = /authorization|api[-_]?key|token|secret|password/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack };
  }
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && typeof v === 'string' ? '[Redacted]' : sanitize(v, depth + 1);
  }
  return out;
}

/** pino-compatible JSON-lines logger for processes without Fastify (the worker, scripts). Redacts secret-looking keys. */
export function createConsoleLogger(level: Level, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_VALUE[level];
  const write = (lvl: Exclude<Level, 'silent'>, obj: object, msg?: string): void => {
    if (LEVEL_VALUE[lvl] < threshold) return;
    const line = JSON.stringify({
      level: LEVEL_VALUE[lvl],
      time: Date.now(),
      ...bindings,
      ...(sanitize(obj) as Record<string, unknown>),
      ...(msg !== undefined ? { msg } : {}),
    });
    (LEVEL_VALUE[lvl] >= LEVEL_VALUE.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (obj, msg) => write('debug', obj, msg),
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
