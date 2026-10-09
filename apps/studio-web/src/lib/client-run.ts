import { DirectorRunDTOSchema, UsageReportSchema, type DirectorRunDTO } from '@vc/schema';
import type { z } from 'zod';

/**
 * The run as the browser sees it (run panel + `/api/runs/:id` polling): a `DirectorRunDTO` whose usage report keeps
 * only the totals. A long run has hundreds of per-stage usage rows (~100 KB) that the panel never shows; they stay
 * on the server (the Usage tab renders them server-side).
 */
export const ClientRunSchema = DirectorRunDTOSchema.extend({
  usage: UsageReportSchema.pick({ totals: true }).nullable(),
});
export type ClientRun = z.infer<typeof ClientRunSchema>;

export function toClientRun(run: DirectorRunDTO): ClientRun {
  return { ...run, usage: run.usage ? { totals: run.usage.totals } : null };
}
