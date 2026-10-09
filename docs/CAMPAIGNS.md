# Campaigns MVP: personalized WhatsApp video campaigns

> This is the original product in this repo. It keeps running as-is beside the new AI Video Studio and is planned to merge into the studio as a module (see [ROADMAP.md](ROADMAP.md), M7).

Upload a CSV, and every contact gets their own video ("Hi Asha! Something special for you in Chennai"), sent as a WhatsApp template message.

```
CSV upload ─▶ API (Express + Postgres) ─▶ render queue (BullMQ/Redis)
                                              │
                                              ▼
                          worker: Remotion intro (React → MP4)
                                  + ElevenLabs voice-over (optional)
                                  + background music, ducked under the voice (optional)
                                  + shared base video (encoded once per template)
                                              │
                                              ▼
                          storage (local disk or S3/R2) ─▶ send queue ─▶ WhatsApp Cloud API
                                                                            │
                                         delivery/read webhooks ◀───────────┘
```

## Repo layout

| Path | What |
|---|---|
| `apps/api` | Express 5 REST API: templates, campaigns, CSV import, render/send triggers, WhatsApp webhook, local media |
| `apps/worker` | BullMQ workers: rendering (Remotion + FFmpeg) and WhatsApp sending (rate-limited) |
| `apps/web` | React + Vite panel: create campaign → upload CSV → preview → send → track |
| `packages/video` | Remotion compositions (the video templates, written in React) |
| `packages/core` | Shared config, DB, queues, storage, WhatsApp client, CSV/phone helpers |
| `db/migrations` | Plain SQL migrations |

## Quick start

Needs Node 22+, pnpm 10, FFmpeg, Postgres 14+, and Redis.

```bash
docker compose up -d          # Postgres + Redis (or use your own)
cp .env.example .env
pnpm install
pnpm campaigns:db:migrate     # creates tables + a starter template

pnpm campaigns:dev:api        # http://localhost:4000
pnpm campaigns:dev:worker     # bundles the Remotion project, then waits for jobs
pnpm campaigns:dev:web        # http://localhost:5173 (log in with ADMIN_API_KEY)
pnpm campaigns:studio         # optional: Remotion Studio to design templates live
```

Without `WHATSAPP_TOKEN`, sends run in **dry-run** mode: the worker logs what it would send and marks messages `dry_run`. That makes it safe to test the whole flow.

## CSV format

```csv
name,phone,city,offer
Asha,9876543210,Chennai,20% off
Ravi,+91 98765 00000,Madurai,Free upgrade
```

- The phone column can be named `phone`, `mobile`, `number`, `whatsapp`, or `phone_number`. 10-digit numbers get `DEFAULT_COUNTRY_CODE` (91).
- Invalid and duplicate rows are skipped and reported back. A phone is unique per campaign, so re-uploading is safe.
- Every other column becomes a variable usable in templates as `{city}`, `{offer}`, …

## Templates

A template is a Remotion composition plus props. String props support `{var}` and `{var|fallback}`:

```json
{
  "headline": "Hi {name|there}!",
  "subline": "We have something special for you in {city|your city}",
  "brandName": "Your Brand",
  "brandColor": "#4f46e5",
  "logoUrl": "https://…/logo.png",
  "voiceText": "Hi {name|there}, this video is just for you.",
  "musicUrl": "https://…/music.mp3",
  "musicVolume": 0.25
}
```

| Prop | Effect |
|---|---|
| `voiceText` | Spoken with ElevenLabs when `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` are set. The intro stretches to fit the voice. |
| `voiceUrl` | A ready-made voice-over file (e.g. `https://…/voices/{phone}.mp3`). Takes priority over `voiceText`. |
| `musicUrl` / `musicVolume` | Background music under the intro, looped to length. When there's a voice, the music ducks (drops ~11 dB) while the voice speaks. |
| `base_video_url` (column) | A shared video appended after the intro (product demo, offer explainer). |
| `base_video_fit` (column) | `pad` letterboxes non-vertical footage (safe for slides and text). `crop` center-crops to fill 9:16 (better for people). |

Campaigns can override any prop (`campaigns.props`), e.g. a different `brandColor` per client.

**Why the base video is cheap:** every segment is encoded with identical settings, so intro and base are joined with `ffmpeg -c copy` (no re-encode). The base is normalized once per template and cached. Each contact only pays for a ~4 s intro, about 8–10 s of render time on a 4-core box at concurrency 1. Scale out by running more workers.

Voice-overs are loudness-normalized to -16 LUFS so every video plays at a consistent volume on phones.

### Included templates

| Template | Composition | What it is |
|---|---|---|
| Personalized Intro (vertical) | `PersonalizedIntro` | 4 s greeting card ("Hi {name}!"). Pairs with a shared base video. |
| Travel Offer (vertical) | `TravelOffer` | 4 scenes: greeting → trip + highlights → price reveal → "Reply YES on WhatsApp". CSV columns `destination`, `trip`, `price`, `old_price` fill it in. `sceneSplits` (e.g. `"0.2,0.49,0.735"`) lines the scenes up with the voice-over. |

Demo output: [`demo/kerala-offer-asha.mp4`](../demo/kerala-offer-asha.mp4), a 15.6 s render for one contact with an ElevenLabs voice-over (~35 s render time).

New template: add a component in `packages/video/src`, register it in `Root.tsx`, then `POST /api/templates` with its `compositionId`.

## WhatsApp setup

1. In Meta Business Manager, create a template with a **Video** header. The starter template expects `personalized_video` in `en` with body `Hi {{1}}, …`.
2. Set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`, then `PATCH /api/templates/:id` with `waTemplateName`, `waTemplateLang`, and `waBodyParams` (e.g. `["name|there", "city"]`).
3. Videos must be reachable by Meta. Use `STORAGE_DRIVER=s3` (Cloudflare R2 is cheapest for egress), or expose the API with ngrok/cloudflared and set `PUBLIC_BASE_URL`.
4. Webhook: set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`, and point Meta to `https://<api>/webhooks/whatsapp` for `messages` status updates (sent → delivered → read).

Limits handled: WhatsApp's 16 MB video cap (renders above it fail with a clear error), out-of-order status webhooks (status only moves forward), and double-sends (one message per contact, ever).

## API

All `/api/*` routes need `Authorization: Bearer $ADMIN_API_KEY`.

| Method | Route | |
|---|---|---|
| GET/POST | `/api/templates` | list / create |
| PATCH | `/api/templates/:id` | update (base video, WhatsApp template, props) |
| GET/POST | `/api/campaigns` | list with stats / create `{name, templateId, props}` |
| GET | `/api/campaigns/:id` | campaign + render/message counts |
| GET | `/api/campaigns/:id/contacts?limit&offset` | contacts with render + message status |
| POST | `/api/campaigns/:id/contacts` | multipart `file` CSV |
| POST | `/api/campaigns/:id/render` | `{limit?, force?}`: `limit: 3` for previews, `force` re-renders done videos |
| POST | `/api/campaigns/:id/send` | `{retryFailed?}`: queues rendered contacts |
| GET/POST | `/webhooks/whatsapp` | Meta verification + status updates |

## Licensing note

Remotion is free for individuals and companies with up to 3 employees. Above that, a [company license](https://www.remotion.pro/license) is required.

## Next steps

- Multi-tenant accounts + auth (replace the single admin key), and per-tenant WhatsApp numbers
- Credit/billing per rendered video and per message
- Click tracking (short links with UTM) and a reply inbox
- RCS rich-card sending with SMS fallback, reusing the same rendered videos
- Dockerfile for the worker (Chromium + FFmpeg) and autoscaling on queue depth
