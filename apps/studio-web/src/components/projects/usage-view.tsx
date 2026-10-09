import type { DirectorRunDTO, UsageReport } from '@vc/schema';
import { ChartColumn, Check, Minus } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { RunStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatElapsed } from '@/lib/duration';
import { formatCompactNumber, formatDateTime, formatLatency, formatNumber, formatUsd } from '@/lib/format';
import { STAGE_LABELS } from '@/lib/run-status';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** Per-stage usage table: stage, chunk, attempts, cached, tokens, est. cost. */
export function UsageTable({ usage }: { usage: UsageReport }) {
  const { totals } = usage;
  const anyUnknownPricing = usage.stages.some((s) => !s.pricingKnown);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Calls" value={`${formatNumber(totals.calls)}`} />
        <Metric label="Cached calls" value={formatNumber(totals.cachedCalls)} />
        <Metric label="Input tokens" value={formatCompactNumber(totals.inputTokens)} />
        <Metric label="Output tokens" value={formatCompactNumber(totals.outputTokens)} />
        <Metric label="Cache read / write" value={`${formatCompactNumber(totals.cacheReadTokens)} / ${formatCompactNumber(totals.cacheWriteTokens)}`} />
        <Metric label="Est. cost" value={formatUsd(totals.estimatedCostUsd)} />
      </div>
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Stage</TableHead>
              <TableHead>Chunk</TableHead>
              <TableHead className="hidden md:table-cell">Model</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead className="text-center">Cached</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Cache read</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Cache write</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Latency</TableHead>
              <TableHead className="text-right">Est. cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.stages.map((stage, i) => (
              <TableRow key={`${stage.stage}-${stage.chunk ?? ''}-${i}`}>
                <TableCell className="whitespace-nowrap font-medium">{STAGE_LABELS[stage.stage]}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{stage.chunk ?? '—'}</TableCell>
                <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                  {stage.provider} · {stage.model}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {stage.attempts > 1 ? <Badge variant="warning">{stage.attempts}</Badge> : stage.attempts}
                </TableCell>
                <TableCell className="text-center">
                  {stage.cached ? (
                    <Check className="mx-auto size-4 text-success" aria-label="cached" />
                  ) : (
                    <Minus className="mx-auto size-4 text-muted-foreground" aria-label="not cached" />
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(stage.usage.inputTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(stage.usage.outputTokens)}</TableCell>
                <TableCell className="hidden text-right tabular-nums lg:table-cell">
                  {formatNumber(stage.usage.cacheReadTokens)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums lg:table-cell">
                  {formatNumber(stage.usage.cacheWriteTokens)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatLatency(stage.latencyMs)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUsd(stage.estimatedCostUsd)}
                  {stage.pricingKnown ? '' : '*'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2}>Total</TableCell>
              <TableCell className="hidden md:table-cell" />
              <TableCell />
              <TableCell className="text-center tabular-nums">{formatNumber(totals.cachedCalls)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(totals.inputTokens)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(totals.outputTokens)}</TableCell>
              <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatNumber(totals.cacheReadTokens)}</TableCell>
              <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatNumber(totals.cacheWriteTokens)}</TableCell>
              <TableCell className="hidden sm:table-cell" />
              <TableCell className="text-right tabular-nums">{formatUsd(totals.estimatedCostUsd)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      {anyUnknownPricing ? (
        <p className="text-xs text-muted-foreground">* No pricing configured for this model — cost shown as $0.</p>
      ) : null}
    </div>
  );
}

export function UsageView({ run, runs }: { run: DirectorRunDTO | null; runs: readonly DirectorRunDTO[] | null }) {
  return (
    <div className="flex flex-col gap-6">
      {run?.usage ? (
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="font-semibold">
              Usage for run {run.versionNumber ? `→ v${run.versionNumber}` : ''}
            </h3>
            <p className="text-sm text-muted-foreground">
              {run.provider} · {run.model} · started {run.startedAt ? formatDateTime(run.startedAt) : '—'}
            </p>
          </div>
          <UsageTable usage={run.usage} />
        </section>
      ) : (
        <EmptyState
          icon={ChartColumn}
          title="No usage recorded yet"
          description="Token usage and estimated cost appear here when a director run finishes."
        />
      )}

      {runs && runs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Run history</CardTitle>
            <CardDescription>Latest {runs.length} director runs for this project.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Model</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Est. cost</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Duration</TableHead>
                  <TableHead className="text-right">Version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                    <TableCell>
                      <RunStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {r.provider} · {r.model}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.usage ? formatCompactNumber(r.usage.totals.inputTokens + r.usage.totals.outputTokens) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.usage ? formatUsd(r.usage.totals.estimatedCostUsd) : '—'}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">
                      {r.finishedAt ? (formatElapsed(r.startedAt, r.finishedAt) ?? '—') : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.versionNumber ? `v${r.versionNumber}` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
