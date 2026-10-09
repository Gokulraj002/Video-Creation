import type { ResourceLimits } from '@vc/schema';
import { CircleCheck, CircleX } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ApiErrorAlert, ApiErrorState } from '@/components/api-error-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration, formatDurationLong } from '@/lib/duration';
import { formatNumber } from '@/lib/format';
import { ENGINE_LABELS, genreLabel } from '@/lib/options';
import { attempt, getHealth, getMe, getStudioApiConnectionInfo, getSystemConfig } from '@/lib/studio-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Settings' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium sm:text-right">{children}</dd>
    </div>
  );
}

function YesNo({ value, yes = 'Yes', no = 'No' }: { value: boolean; yes?: string; no?: string }) {
  return value ? (
    <Badge variant="success">
      <CircleCheck />
      {yes}
    </Badge>
  ) : (
    <Badge variant="destructive">
      <CircleX />
      {no}
    </Badge>
  );
}

const LIMIT_ROWS: readonly { key: keyof ResourceLimits; label: string; format: (v: number) => string }[] = [
  { key: 'maxDurationSeconds', label: 'Max duration', format: (v) => `${formatDurationLong(v)} (${formatNumber(v)} s)` },
  { key: 'maxWidth', label: 'Max width', format: (v) => `${formatNumber(v)} px` },
  { key: 'maxHeight', label: 'Max height', format: (v) => `${formatNumber(v)} px` },
  { key: 'maxFps', label: 'Max frame rate', format: (v) => `${formatNumber(v)} fps` },
  { key: 'maxScenes', label: 'Max scenes', format: formatNumber },
  { key: 'maxChapters', label: 'Max chapters', format: formatNumber },
  { key: 'maxTracks', label: 'Max tracks', format: formatNumber },
  { key: 'maxAssets', label: 'Max assets', format: formatNumber },
  { key: 'maxPromptChars', label: 'Max prompt length', format: (v) => `${formatNumber(v)} characters` },
];

export default async function SettingsPage() {
  const connection = getStudioApiConnectionInfo();
  const [health, config, me] = await Promise.all([
    attempt(() => getHealth()),
    attempt(() => getSystemConfig()),
    attempt(() => getMe()),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Read-only view of the Studio API configuration. Change these via the API’s environment variables."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>How this web app reaches @vc/studio-api (server-side only).</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Row label="API URL">
                <code className="font-mono text-xs">{connection.baseUrl}</code>
              </Row>
              <Row label="Access token">
                <YesNo value={connection.tokenConfigured} yes="Configured" no="Missing" />
              </Row>
              <Row label="Health">
                {health.ok ? <YesNo value yes={`OK · v${health.data.version}`} /> : <YesNo value={false} no="Unreachable" />}
              </Row>
              <Row label="Signed in as">
                {me.ok ? (
                  <span>
                    {me.data.name ? `${me.data.name} · ` : ''}
                    {me.data.email}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Row>
            </dl>
          </CardContent>
        </Card>

        {config.ok ? (
          <Card>
            <CardHeader>
              <CardTitle>AI Director</CardTitle>
              <CardDescription>Provider used for new director runs.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Row label="Provider">{config.data.aiProvider.name}</Row>
                <Row label="Model">
                  <code className="font-mono text-xs">{config.data.aiProvider.model}</code>
                </Row>
                <Row label="Mode">
                  <Badge variant={config.data.aiProvider.mode === 'live' ? 'warning' : 'secondary'}>
                    {config.data.aiProvider.mode === 'live' ? 'Live (spends credits)' : 'Mock (no credits)'}
                  </Badge>
                </Row>
                <Row label="Configured">
                  <YesNo value={config.data.aiProvider.configured} />
                </Row>
                <Row label="Queue driver">
                  <code className="font-mono text-xs">{config.data.queueDriver}</code>
                </Row>
                <Row label="Prompt version">
                  <code className="font-mono text-xs">{config.data.promptVersion}</code>
                </Row>
              </dl>
            </CardContent>
          </Card>
        ) : (
          <div>
            <ApiErrorState failure={config.failure} retryHref="/settings" />
          </div>
        )}
      </div>

      {!me.ok && config.ok ? (
        <div className="mt-6">
          <ApiErrorAlert failure={me.failure} title="Could not load the current user" />
        </div>
      ) : null}

      {config.ok ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Resource limits</CardTitle>
              <CardDescription>Configurable on the API (LIMIT_* env vars) — not hardcoded.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                {LIMIT_ROWS.map((row) => (
                  <Row key={row.key} label={row.label}>
                    <span className="tabular-nums">{row.format(config.data.limits[row.key])}</span>
                  </Row>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Engines</CardTitle>
              <CardDescription>Scene engines the director may choose from.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {config.data.engines.map((engine) => (
                  <li key={engine.engine} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">{ENGINE_LABELS[engine.engine]}</p>
                      <p className="font-mono text-xs text-muted-foreground">{engine.engine}</p>
                      {engine.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{engine.reason}</p> : null}
                    </div>
                    <YesNo value={engine.available} yes="Available" no="Unavailable" />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Template catalog</CardTitle>
              <CardDescription>
                {config.data.templates.length} fixed templates the director maps scenes onto (LLM output is data, never
                code).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Template</TableHead>
                    <TableHead>Engine</TableHead>
                    <TableHead className="hidden md:table-cell">Genres</TableHead>
                    <TableHead className="text-right">Min</TableHead>
                    <TableHead className="hidden min-w-72 lg:table-cell">Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {config.data.templates.map((template) => (
                    <TableRow key={template.id}>
                      <TableCell className="align-top">
                        <p className="font-medium">{template.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{template.id}</p>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant={template.engine === 'three' ? 'warning' : 'default'}>
                          {ENGINE_LABELS[template.engine]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden align-top md:table-cell">
                        <div className="flex max-w-80 flex-wrap gap-1">
                          {template.genres.map((genre) => (
                            <Badge key={genre} variant="outline">
                              {genreLabel(genre)}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">
                        {formatDuration(template.minDurationSeconds)}
                      </TableCell>
                      <TableCell className="hidden align-top text-muted-foreground lg:table-cell">
                        {template.description}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
