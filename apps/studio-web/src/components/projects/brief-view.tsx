import type { CreativeBrief } from '@vc/schema';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { genreLabel } from '@/lib/options';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

export function BriefView({ brief }: { brief: CreativeBrief }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{genreLabel(brief.genre)}</Badge>
            {brief.tone.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
          <CardTitle className="pt-2 text-xl">{brief.title}</CardTitle>
          <p className="text-base italic text-muted-foreground">{brief.logline}</p>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Section title="Objective">{brief.objective}</Section>
          <Section title="Target audience">{brief.targetAudience}</Section>
          <Section title="Key messages">
            <ul className="list-disc space-y-1 pl-5">
              {brief.keyMessages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
          <Section title="Call to action">{brief.callToAction ?? <span className="text-muted-foreground">None</span>}</Section>
          {brief.referenceInfluence ? <Section title="Reference influence">{brief.referenceInfluence}</Section> : null}
          {brief.brandConsistencyNotes ? <Section title="Brand consistency">{brief.brandConsistencyNotes}</Section> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Visual style</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex overflow-hidden rounded-lg border">
            {brief.visualStyle.palette.map((color, i) => (
              <div key={`${color}-${i}`} className="flex h-16 flex-1 items-end p-1.5" style={{ backgroundColor: color }}>
                <span className="rounded bg-black/40 px-1 font-mono text-[10px] uppercase text-white">{color}</span>
              </div>
            ))}
          </div>
          <Section title="Look">{brief.visualStyle.description}</Section>
          <Section title="Typography">{brief.visualStyle.typography}</Section>
          <Section title="Motion language">{brief.visualStyle.motionLanguage}</Section>
        </CardContent>
      </Card>
    </div>
  );
}
