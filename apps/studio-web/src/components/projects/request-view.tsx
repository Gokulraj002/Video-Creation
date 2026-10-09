import { resolveDimensions, type VideoRequest } from '@vc/schema';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDuration } from '@/lib/duration';
import { genreLabel } from '@/lib/options';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function safeDimensions(request: VideoRequest): string {
  try {
    const { width, height } = resolveDimensions(request);
    return `${width} × ${height}`;
  } catch {
    return '—';
  }
}

/** The original user request (as stored by the API). */
export function RequestView({ request }: { request: VideoRequest }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Prompt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{request.prompt}</p>
          {request.styleNotes ? (
            <div className="space-y-1">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Style notes</h4>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{request.styleNotes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Genre">{genreLabel(request.genre)}</Row>
            <Row label="Duration">{formatDuration(request.durationSeconds)}</Row>
            <Row label="Aspect ratio">{request.aspectRatio}</Row>
            <Row label="Resolution">
              {request.resolution} · {safeDimensions(request)}
            </Row>
            <Row label="Frame rate">{request.fps} fps</Row>
            <Row label="Language">{request.language}</Row>
            <Row label="Voice-over">
              {request.voiceOver.enabled
                ? [request.voiceOver.style, request.voiceOver.gender].filter(Boolean).join(' · ') || 'On'
                : 'Off'}
            </Row>
            <Row label="Music">{request.music.enabled ? request.music.mood || 'On' : 'Off'}</Row>
            {request.brand ? (
              <Row label="Brand">
                <span className="inline-flex items-center gap-2">
                  {request.brand.name ?? ''}
                  <span className="inline-flex gap-1">
                    {request.brand.colors.map((color) => (
                      <span
                        key={color}
                        className="inline-block size-4 rounded-full border"
                        style={{ backgroundColor: color }}
                        title={color}
                      />
                    ))}
                  </span>
                </span>
              </Row>
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
