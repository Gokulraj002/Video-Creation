import { KeyRound, PlugZap, ServerCrash, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { describeFailure, type ApiFailure } from '@/lib/api-failure';

function iconFor(failure: ApiFailure) {
  switch (failure.kind) {
    case 'unreachable':
      return PlugZap;
    case 'unauthorized':
    case 'not_configured':
      return KeyRound;
    case 'invalid_response':
      return ServerCrash;
    default:
      return TriangleAlert;
  }
}

/** Full-width card explaining why the Studio API call failed (unreachable, 401, misconfigured…). */
export function ApiErrorState({ failure, retryHref }: { failure: ApiFailure; retryHref?: string }) {
  const copy = describeFailure(failure);
  const Icon = iconFor(failure);
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-start gap-4 p-6 sm:flex-row">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-lg font-semibold">{copy.title}</h2>
          <p className="break-words text-sm text-muted-foreground">{copy.description}</p>
          {copy.hint ? (
            <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {copy.hint}
            </p>
          ) : null}
          {retryHref ? (
            <div className="pt-1">
              <Button asChild variant="outline" size="sm">
                {/* Plain anchor: a full reload re-runs every server request for the page. */}
                <a href={retryHref}>Try again</a>
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Compact inline variant for secondary data (e.g. a panel that could not load). */
export function ApiErrorAlert({ failure, title }: { failure: ApiFailure; title?: string }) {
  const copy = describeFailure(failure);
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>{title ?? copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        {copy.hint ? <p className="font-mono text-xs">{copy.hint}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
