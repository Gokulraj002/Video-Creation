'use client';

import { resolveDimensions, type AspectRatio, type ResourceLimits, type Resolution } from '@vc/schema';
import { LoaderCircle, Plus, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useActionState, useId, useState, startTransition, type FormEvent, type ReactNode } from 'react';
import { createProjectAction } from '@/app/projects/new/actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  DURATION_UNIT_LABELS,
  DURATION_UNITS,
  formatDuration,
  formatDurationLong,
  isDurationUnit,
  parseDurationInput,
  type DurationUnit,
} from '@/lib/duration';
import { formatNumber } from '@/lib/format';
import {
  ASPECT_RATIO_OPTIONS,
  GENRE_OPTIONS,
  LANGUAGE_SUGGESTIONS,
  RESOLUTION_OPTIONS,
  VOICE_GENDER_OPTIONS,
} from '@/lib/options';
import { FORM_FIELDS, MAX_BRAND_COLORS, parseProjectForm, type FieldErrors, type FormErrorKey } from '@/lib/project-form';
import { INITIAL_CREATE_PROJECT_STATE } from '@/lib/project-form-state';
import { cn } from '@/lib/utils';

const DEFAULT_BRAND_PALETTE = ['#6366f1', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444'];
const DEFAULT_PROMPT_LIMIT = 20_000;

function Field({
  id,
  label,
  error,
  hint,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function errorProps(id: string, error: string | undefined) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
}

export function ProjectForm({ limits }: { limits: ResourceLimits | null }) {
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  const [state, formAction, pending] = useActionState(createProjectAction, INITIAL_CREATE_PROJECT_STATE);

  const [genre, setGenre] = useState<string>('explainer');
  const [durationValue, setDurationValue] = useState('30');
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('s');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [resolution, setResolution] = useState<Resolution>('1080p');
  const [customWidth, setCustomWidth] = useState('1080');
  const [customHeight, setCustomHeight] = useState('1080');
  const [fps, setFps] = useState('30');
  const [promptLength, setPromptLength] = useState(0);
  const [brandColors, setBrandColors] = useState<string[]>([]);
  const [voiceOver, setVoiceOver] = useState(true);
  const [voiceGender, setVoiceGender] = useState<string>('any');
  const [music, setMusic] = useState(false);
  const [localErrors, setLocalErrors] = useState<FieldErrors | null>(null);
  const [localFormError, setLocalFormError] = useState<string | null>(null);

  const serverErrors = state.status === 'error' ? state.fieldErrors : {};
  const errors: FieldErrors = localErrors ?? serverErrors;
  const formError = localErrors ? localFormError : state.status === 'error' ? state.formError : null;
  const err = (key: FormErrorKey) => errors[key];

  const isCustom = aspectRatio === 'custom' || resolution === 'custom';
  const promptLimit = limits?.maxPromptChars ?? DEFAULT_PROMPT_LIMIT;
  const maxFps = limits?.maxFps ?? 240;

  const duration = parseDurationInput(durationValue, durationUnit);
  const fpsNumber = /^\d+$/.test(fps) ? Number(fps) : Number.NaN;
  const overLimit = duration.ok && limits ? duration.seconds > limits.maxDurationSeconds : false;

  let dimensions: { width: number; height: number } | null = null;
  try {
    dimensions = resolveDimensions({
      aspectRatio,
      resolution,
      customWidth: Number(customWidth) || undefined,
      customHeight: Number(customHeight) || undefined,
    });
  } catch {
    dimensions = null;
  }
  const dimensionsOverLimit =
    dimensions !== null && limits !== null && (dimensions.width > limits.maxWidth || dimensions.height > limits.maxHeight);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Submit manually so React does not reset the form fields when the action returns validation errors.
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const local = parseProjectForm(formData, limits);
    if (!local.success) {
      setLocalErrors(local.fieldErrors);
      setLocalFormError(local.formError);
      return;
    }
    setLocalErrors(null);
    setLocalFormError(null);
    startTransition(() => formAction(formData));
  };

  const addColor = () =>
    setBrandColors((colors) =>
      colors.length >= MAX_BRAND_COLORS
        ? colors
        : [...colors, DEFAULT_BRAND_PALETTE.find((c) => !colors.includes(c)) ?? '#64748b'],
    );

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* Hidden inputs mirror the controlled Radix widgets so FormData has every field. */}
      <input type="hidden" name={FORM_FIELDS.genre} value={genre} />
      <input type="hidden" name={FORM_FIELDS.durationUnit} value={durationUnit} />
      <input type="hidden" name={FORM_FIELDS.aspectRatio} value={aspectRatio} />
      <input type="hidden" name={FORM_FIELDS.resolution} value={resolution} />
      <input type="hidden" name={FORM_FIELDS.voiceOverEnabled} value={voiceOver ? 'on' : ''} />
      <input type="hidden" name={FORM_FIELDS.voiceOverGender} value={voiceGender} />
      <input type="hidden" name={FORM_FIELDS.musicEnabled} value={music ? 'on' : ''} />

      <div className="flex min-w-0 flex-col gap-6">
        {formError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Could not create the project</AlertTitle>
            <AlertDescription>
              <p>{formError}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>What should we make?</CardTitle>
            <CardDescription>
              The AI Director turns this brief into a creative brief, script, storyboard, shot list and a frame-accurate
              timeline.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field id={fid('title')} label="Title" error={err('title')}>
              <Input
                id={fid('title')}
                name={FORM_FIELDS.title}
                maxLength={200}
                placeholder="e.g. Launch film for the Aurora smart lamp"
                autoComplete="off"
                required
                {...errorProps(fid('title'), err('title'))}
              />
            </Field>

            <Field
              id={fid('prompt')}
              label="Prompt"
              error={err('prompt')}
              hint={
                <span className="tabular-nums">
                  {formatNumber(promptLength)} / {formatNumber(promptLimit)} characters
                </span>
              }
            >
              <Textarea
                id={fid('prompt')}
                name={FORM_FIELDS.prompt}
                rows={8}
                maxLength={promptLimit}
                onChange={(e) => setPromptLength(e.currentTarget.value.length)}
                placeholder="Describe the story, audience, key messages and the feeling you want. Paste a script or outline if you have one."
                required
                {...errorProps(fid('prompt'), err('prompt'))}
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                id={fid('genre')}
                label="Genre"
                error={err('genre')}
                hint={GENRE_OPTIONS.find((g) => g.value === genre)?.hint}
              >
                <Select value={genre} onValueChange={setGenre}>
                  <SelectTrigger id={fid('genre')} {...errorProps(fid('genre'), err('genre'))}>
                    <SelectValue placeholder="Pick a genre" />
                  </SelectTrigger>
                  <SelectContent>
                    {GENRE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                id={fid('language')}
                label="Language"
                error={err('language')}
                hint="BCP-47 tag, e.g. en, en-GB, pt-BR"
              >
                <Input
                  id={fid('language')}
                  name={FORM_FIELDS.language}
                  defaultValue="en"
                  list={fid('languages')}
                  autoComplete="off"
                  {...errorProps(fid('language'), err('language'))}
                />
                <datalist id={fid('languages')}>
                  {LANGUAGE_SUGGESTIONS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </datalist>
              </Field>
            </div>

            <Field
              id={fid('styleNotes')}
              label={
                <>
                  Style notes <span className="font-normal text-muted-foreground">(optional)</span>
                </>
              }
              error={err('styleNotes')}
            >
              <Textarea
                id={fid('styleNotes')}
                name={FORM_FIELDS.styleNotes}
                rows={3}
                maxLength={2000}
                placeholder="Pacing, mood, typography, references to avoid or emulate…"
                {...errorProps(fid('styleNotes'), err('styleNotes'))}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Brand</CardTitle>
            <CardDescription>Optional. Colors feed the director’s palette and the animatic preview.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field
              id={fid('brandName')}
              label="Brand name"
              error={err('brandName')}
            >
              <Input
                id={fid('brandName')}
                name={FORM_FIELDS.brandName}
                maxLength={120}
                placeholder="e.g. Aurora"
                autoComplete="organization"
                {...errorProps(fid('brandName'), err('brandName'))}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                Brand colors{' '}
                <span className="font-normal text-muted-foreground">
                  ({brandColors.length}/{MAX_BRAND_COLORS})
                </span>
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {brandColors.map((color, index) => (
                  <div key={index} className="flex items-center gap-1 rounded-md border bg-card p-1 pr-1.5">
                    <input
                      type="color"
                      name={FORM_FIELDS.brandColor}
                      value={color}
                      aria-label={`Brand color ${index + 1}`}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setBrandColors((colors) => colors.map((c, i) => (i === index ? value : c)));
                      }}
                      className="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                    <span className="font-mono text-xs uppercase text-muted-foreground">{color}</span>
                    <button
                      type="button"
                      onClick={() => setBrandColors((colors) => colors.filter((_, i) => i !== index))}
                      className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`Remove brand color ${index + 1}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                {brandColors.length < MAX_BRAND_COLORS ? (
                  <Button type="button" variant="outline" size="sm" onClick={addColor}>
                    <Plus />
                    Add color
                  </Button>
                ) : null}
              </div>
              {err('brandColors') ? (
                <p className="text-xs font-medium text-destructive" role="alert">
                  {err('brandColors')}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Format</CardTitle>
            <CardDescription>Any length — short spots to multi-hour long-form.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field
              id={fid('duration')}
              label="Duration"
              error={err('duration') ?? (overLimit && limits ? `Exceeds the configured limit of ${formatDurationLong(limits.maxDurationSeconds)}` : undefined)}
              hint={
                <>
                  {duration.ok ? `${formatDuration(duration.seconds)}` : 'Enter a positive number'}
                  {duration.ok && Number.isFinite(fpsNumber) && fpsNumber > 0
                    ? ` · ${formatNumber(Math.round(duration.seconds * fpsNumber))} frames`
                    : ''}
                  {' · '}
                  {limits
                    ? `Configured limit: ${formatDurationLong(limits.maxDurationSeconds)}`
                    : 'Limit unavailable (API offline)'}
                </>
              }
            >
              <div className="flex gap-2">
                <Input
                  id={fid('duration')}
                  name={FORM_FIELDS.durationValue}
                  inputMode="decimal"
                  value={durationValue}
                  onChange={(e) => setDurationValue(e.currentTarget.value)}
                  className="flex-1"
                  {...errorProps(fid('duration'), err('duration'))}
                />
                <Select value={durationUnit} onValueChange={(v) => isDurationUnit(v) && setDurationUnit(v)}>
                  <SelectTrigger className="w-32" aria-label="Duration unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {DURATION_UNIT_LABELS[unit]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field id={fid('aspectRatio')} label="Aspect ratio" error={err('aspectRatio')}>
                <Select
                  value={aspectRatio}
                  onValueChange={(v) => {
                    const match = ASPECT_RATIO_OPTIONS.find((o) => o.value === v);
                    if (match) setAspectRatio(match.value);
                  }}
                >
                  <SelectTrigger id={fid('aspectRatio')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIO_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id={fid('resolution')} label="Resolution" error={err('resolution')}>
                <Select
                  value={resolution}
                  onValueChange={(v) => {
                    const match = RESOLUTION_OPTIONS.find((o) => o.value === v);
                    if (match) setResolution(match.value);
                  }}
                >
                  <SelectTrigger id={fid('resolution')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {isCustom ? (
              <div className="grid grid-cols-2 gap-3">
                <Field id={fid('customWidth')} label="Width (px)" error={err('customWidth')}>
                  <Input
                    id={fid('customWidth')}
                    name={FORM_FIELDS.customWidth}
                    inputMode="numeric"
                    value={customWidth}
                    onChange={(e) => setCustomWidth(e.currentTarget.value)}
                    {...errorProps(fid('customWidth'), err('customWidth'))}
                  />
                </Field>
                <Field id={fid('customHeight')} label="Height (px)" error={err('customHeight')}>
                  <Input
                    id={fid('customHeight')}
                    name={FORM_FIELDS.customHeight}
                    inputMode="numeric"
                    value={customHeight}
                    onChange={(e) => setCustomHeight(e.currentTarget.value)}
                    {...errorProps(fid('customHeight'), err('customHeight'))}
                  />
                </Field>
                <p className="col-span-2 text-xs text-muted-foreground">Even numbers between 16 and 8192.</p>
              </div>
            ) : null}

            <p
              className={cn(
                'rounded-md bg-muted px-3 py-2 text-xs tabular-nums',
                dimensionsOverLimit ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              Output:{' '}
              {dimensions ? (
                <span className="font-medium text-foreground">
                  {dimensions.width} × {dimensions.height} px
                </span>
              ) : (
                'enter custom dimensions'
              )}
              {limits ? ` · limit ${limits.maxWidth} × ${limits.maxHeight}` : ''}
            </p>

            <Field
              id={fid('fps')}
              label="Frame rate (fps)"
              error={err('fps')}
              hint={`Integer between 1 and ${maxFps}${limits ? ' (configured limit)' : ''}`}
            >
              <Input
                id={fid('fps')}
                name={FORM_FIELDS.fps}
                inputMode="numeric"
                value={fps}
                onChange={(e) => setFps(e.currentTarget.value)}
                list={fid('fps-presets')}
                {...errorProps(fid('fps'), err('fps'))}
              />
              <datalist id={fid('fps-presets')}>
                {[24, 25, 30, 50, 60].filter((v) => v <= maxFps).map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audio</CardTitle>
            <CardDescription>Voice-over drives narration and the caption track.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={fid('voiceOver')}>Voice-over</Label>
              <Switch id={fid('voiceOver')} checked={voiceOver} onCheckedChange={setVoiceOver} />
            </div>
            {voiceOver ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <Field id={fid('voiceOverStyle')} label="Voice style" error={err('voiceOverStyle')}>
                  <Input
                    id={fid('voiceOverStyle')}
                    name={FORM_FIELDS.voiceOverStyle}
                    maxLength={200}
                    placeholder="warm, confident"
                    {...errorProps(fid('voiceOverStyle'), err('voiceOverStyle'))}
                  />
                </Field>
                <Field id={fid('voiceOverGender')} label="Voice" error={err('voiceOverGender')}>
                  <Select value={voiceGender} onValueChange={setVoiceGender}>
                    <SelectTrigger id={fid('voiceOverGender')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICE_GENDER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-4 border-t pt-5">
              <Label htmlFor={fid('music')}>Music</Label>
              <Switch id={fid('music')} checked={music} onCheckedChange={setMusic} />
            </div>
            {music ? (
              <Field id={fid('musicMood')} label="Music mood" error={err('musicMood')}>
                <Input
                  id={fid('musicMood')}
                  name={FORM_FIELDS.musicMood}
                  maxLength={200}
                  placeholder="uplifting electronic, 110 bpm"
                  {...errorProps(fid('musicMood'), err('musicMood'))}
                />
              </Field>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2 lg:sticky lg:top-20">
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
            {pending ? 'Creating project…' : 'Create project & start director'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Creates the project, then queues an AI Director run. You can cancel or re-run it from the project page.
          </p>
        </div>
      </div>
    </form>
  );
}
