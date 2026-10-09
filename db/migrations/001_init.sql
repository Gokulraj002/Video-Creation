-- Templates: a Remotion composition + default props + optional pre-made base video
CREATE TABLE templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  composition_id   text NOT NULL,
  props            jsonb NOT NULL DEFAULT '{}',
  -- Optional shared video appended after the personalized intro (rendered once, reused per contact)
  base_video_url   text,
  -- How a non-vertical base video becomes 9:16: 'pad' (letterbox) or 'crop' (center crop)
  base_video_fit   text NOT NULL DEFAULT 'pad' CHECK (base_video_fit IN ('pad', 'crop')),
  -- Approved WhatsApp template with a VIDEO header
  wa_template_name text,
  wa_template_lang text NOT NULL DEFAULT 'en',
  -- Contact variables mapped, in order, to the template body params {{1}}, {{2}}, ...
  -- Entries are "var" or "var|fallback", e.g. ["name|there", "city"]
  wa_body_params   jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  template_id uuid NOT NULL REFERENCES templates(id),
  -- Campaign-level overrides of template props (offer text, brand color, ...)
  props       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order (rows from one CSV share created_at)
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name        text,
  phone       text NOT NULL,
  vars        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone)
);

CREATE TYPE render_status AS ENUM ('queued', 'rendering', 'done', 'failed');

-- One render per contact; re-rendering resets the row
CREATE TABLE renders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status      render_status NOT NULL DEFAULT 'queued',
  video_url   text,
  error       text,
  render_ms   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE message_status AS ENUM ('queued', 'dry_run', 'sent', 'delivered', 'read', 'failed');

-- One message per contact: protects against accidental double-sends
CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status        message_status NOT NULL DEFAULT 'queued',
  wa_message_id text UNIQUE,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contacts_campaign_idx ON contacts (campaign_id, seq);
