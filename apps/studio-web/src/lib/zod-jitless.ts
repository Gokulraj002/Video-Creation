import { z } from 'zod';

/**
 * Zod v4 compiles object parsers with `new Function` and probes for it when a schema is constructed. The web app's
 * Content-Security-Policy has no `'unsafe-eval'`, so in the browser that probe would raise a CSP violation report.
 * `jitless` makes Zod use its interpreter instead (same results, no eval).
 *
 * Import this module FIRST (before `@vc/schema`) in every client module that evaluates schemas: ES modules run
 * their imports in order, so the flag is set before any schema is built. Server-side parsing keeps the faster JIT.
 */
if (typeof window !== 'undefined') {
  z.config({ jitless: true });
}

export {};
