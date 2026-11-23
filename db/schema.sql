-- Athena — current schema (rolled-up reference).
-- Source of truth for "what should exist" is netlify/database/migrations/*/migration.sql,
-- applied via `netlify database migrations apply` (locally) or automatically on deploy
-- (production/previews). This file is a convenience snapshot — regenerate it whenever a
-- migration lands, don't hand-edit it out of sync.

-- gen_random_uuid() is native to Postgres 13+, no pgcrypto extension needed
-- (and this environment's Postgres doesn't have pgcrypto available anyway).
CREATE EXTENSION IF NOT EXISTS vector; -- pgvector, confirmed supported on Netlify DB

-- Free-form written content: notes, daily rollups, project logs, area pages, captures.
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'daily', 'project', 'area', 'capture')),
  source TEXT,                 -- 'manual' | 'calendar-meetings' | 'work-activity' | 'email-digest' | 'finance' | ...
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ      -- set = hidden everywhere except the app's Archived page
);
CREATE INDEX notes_updated_idx ON notes (updated_at DESC);
CREATE INDEX notes_type_idx ON notes (type);
CREATE INDEX notes_live_updated_idx ON notes (updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX notes_archived_idx ON notes (archived_at DESC) WHERE archived_at IS NOT NULL;

-- Lightweight personal CRM.
CREATE TABLE people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  relationship TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  catch_up_days INT CHECK (catch_up_days IS NULL OR catch_up_days > 0), -- null = default (60)
  acquaintance BOOLEAN NOT NULL DEFAULT false, -- unread since 0013; to be dropped
  keep_in_touch BOOLEAN NOT NULL DEFAULT false, -- true = nudge me to catch up (0013)
  -- Blind indexes (0012): HMAC of the normalised name / email / phone's last
  -- ten digits, so exact lookups work on encrypted values. NULL until sealed.
  name_bidx TEXT,
  email_bidx TEXT,
  phone_bidx TEXT
  -- Birthday: not a column. It's the person's `events` row (kind 'birthday', person_id set).
  -- Organisation: a manual edge person -[works_at]-> organisation.
);
CREATE INDEX people_archived_idx ON people (archived_at DESC) WHERE archived_at IS NOT NULL;
CREATE INDEX people_name_bidx_idx ON people (name_bidx);
CREATE INDEX people_email_bidx_idx ON people (email_bidx);
CREATE INDEX people_phone_bidx_idx ON people (phone_bidx);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX projects_archived_idx ON projects (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX places_live_name_idx ON places (name) WHERE archived_at IS NULL;
CREATE INDEX places_archived_idx ON places (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX organisations_live_name_idx ON organisations (name) WHERE archived_at IS NULL;
CREATE INDEX organisations_archived_idx ON organisations (archived_at DESC) WHERE archived_at IS NOT NULL;

-- Every date Athena knows about: birthdays, anniversaries, appointments, deadlines.
-- `date` is a calendar date. A timed one-off starts at `starts_at` (UTC); a yearly
-- event's optional `time` is wall-clock in whatever zone is looking. Yearly dates
-- without a known year use the placeholder year 2000 (a leap year, so 29 Feb works).
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('birthday', 'anniversary', 'appointment', 'deadline', 'other')),
  date DATE NOT NULL,
  time TIME,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'yearly')),
  year_known BOOLEAN NOT NULL DEFAULT true,
  remind_days_before INT[] NOT NULL DEFAULT '{0}',
  notes TEXT NOT NULL DEFAULT '',
  person_id UUID REFERENCES people(id) ON DELETE CASCADE, -- set for a person's birthday
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The collection that synced it from a calendar; null when added by hand. (0006)
  source TEXT,
  -- Push 30 minutes before a timed event. Synced meetings default to off. (0006)
  timed_push BOOLEAN NOT NULL DEFAULT true,
  -- UTC instant a timed one-off starts; the app shows it in the device's zone. (0007)
  starts_at TIMESTAMPTZ,
  -- Your answer to an invite, the calendar's last answer, whether yours holds,
  -- why the last send failed, and where to send it. (0027, lib/rsvp.ts)
  rsvp TEXT NOT NULL DEFAULT 'none' CHECK (rsvp IN ('going', 'maybe', 'declined', 'none')),
  rsvp_calendar TEXT CHECK (rsvp_calendar IN ('going', 'maybe', 'declined', 'none')),
  rsvp_mine BOOLEAN NOT NULL DEFAULT false,
  rsvp_error TEXT NOT NULL DEFAULT '',
  calendar_connector_id UUID, -- references connectors, below
  calendar_id TEXT,
  calendar_event_id TEXT,
  -- UTC instant a timed one-off ends, as its calendar gives it; null when unknown. (0065)
  ends_at TIMESTAMPTZ,
  CONSTRAINT events_starts_at_one_off CHECK (starts_at IS NULL OR recurrence = 'none')
);
CREATE INDEX events_live_date_idx ON events (date) WHERE archived_at IS NULL;
CREATE INDEX events_archived_idx ON events (archived_at DESC) WHERE archived_at IS NOT NULL;
CREATE UNIQUE INDEX events_person_birthday_idx ON events (person_id) WHERE kind = 'birthday' AND person_id IS NOT NULL;
CREATE INDEX events_live_starts_idx ON events (starts_at) WHERE archived_at IS NULL AND starts_at IS NOT NULL;

-- Generic typed graph: any entity can relate to any entity, with a named relation.
-- This is the "Obsidian-like" network, queryable with recursive CTEs, richer than
-- file backlinks since relation isn't limited to "links to".
CREATE TABLE edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CONSTRAINT edges_source_type_check
    CHECK (source_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record', 'saved', 'commitment', 'reading')),
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL CONSTRAINT edges_target_type_check
    CHECK (target_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record', 'saved', 'commitment', 'reading')),
  target_id UUID NOT NULL,
  relation TEXT NOT NULL DEFAULT 'relates_to',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'record' (0018) is one of the owner's custom records, whatever its kind; 'saved' (0039) a Saved item.
  -- 'content' = derived from athena:// links in a note or custom record body (re-synced on every save,
  -- relation 'mentions'); 'manual' = created explicitly and never touched by that sync.
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'content')),
  UNIQUE (source_type, source_id, target_type, target_id, relation)
);
CREATE INDEX edges_source_idx ON edges (source_type, source_id);
CREATE INDEX edges_target_idx ON edges (target_type, target_id);

-- Time-series: meeting load, issue throughput, finance trend points, habit counts, ...
CREATE TABLE metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX metrics_metric_time_idx ON metrics (metric, recorded_at DESC);

-- Chunked note content + embeddings, for semantic search over `notes`.
CREATE TABLE note_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536), -- dimension matches e.g. text-embedding-3-small
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (note_id, chunk_index)
);
CREATE INDEX note_chunks_embedding_idx ON note_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Finance/health content: ciphertext only, never plaintext. `label` must stay
-- non-sensitive (e.g. "Checking balance snapshot") since it's readable without
-- the decryption key — it's what search/browsing sees before you decrypt anything.
CREATE TABLE sensitive_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('finance', 'health', 'location', 'money', 'home')),
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Health days (migration 0028, lib/health.ts): one sealed row per day and source.
  day DATE,
  source TEXT,
  CONSTRAINT sensitive_blobs_day_sealed CHECK (day IS NULL OR (source ~ '^[a-z_]{2,30}$' AND ciphertext LIKE 'enc:v1:%')),
  -- Money and home days (migration 0035, lib/money.ts): always a day, always sealed, never an amount in the label.
  CONSTRAINT sensitive_blobs_money_sealed CHECK (domain NOT IN ('money', 'home') OR (day IS NOT NULL AND source ~ '^[a-z_]{2,30}$' AND ciphertext LIKE 'enc:v1:%' AND label !~ '[0-9]+\.[0-9]{2}|£|\$|€'))
);
CREATE INDEX sensitive_blobs_domain_idx ON sensitive_blobs (domain, recorded_at DESC);
CREATE UNIQUE INDEX sensitive_blobs_day_idx ON sensitive_blobs (domain, source, day) WHERE day IS NOT NULL;

-- Places and visits (migration 0031, lib/places-visits.ts): visits are 'location' day rows above.
-- A Place's coordinates, ids, town and visit days, sealed as one value.
CREATE TABLE place_geo (
  place_id UUID PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Names and weather looked up once: blind-index key, sealed value.
CREATE TABLE location_cache (
  key TEXT PRIMARY KEY,
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Days still waiting for a place name or the weather.
CREATE TABLE location_todo (
  day DATE PRIMARY KEY,
  since TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Web Push subscriptions (one per installed device that turned reminders on).
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Fingerprint of the token or key that registered it (0057, lib/push.ts); rows whose credential is gone are dropped before a send.
  credential TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency for netlify/functions/reminders.ts: a key is claimed before each send.
CREATE TABLE reminder_log (
  key TEXT PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom reminders (0004): free text at a chosen instant, optionally repeating
-- (same time of day in the owner's zone, settings.timezone) and optionally about an entity.
CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL CHECK (length(btrim(text)) > 0),
  remind_at TIMESTAMPTZ NOT NULL,           -- when it next fires
  repeat TEXT NOT NULL DEFAULT 'none'
    CHECK (repeat IN ('none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly')),
  anchor_day SMALLINT NOT NULL CHECK (anchor_day BETWEEN 1 AND 31), -- day of month it was set for
  about_type TEXT CHECK (about_type IN ('note', 'person', 'project', 'place', 'organisation', 'event')),
  about_id UUID,
  done_at TIMESTAMPTZ,                      -- set = finished (sent once, or marked done)
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((about_type IS NULL) = (about_id IS NULL))
);
CREATE INDEX reminders_pending_idx ON reminders (remind_at) WHERE done_at IS NULL;
CREATE INDEX reminders_done_idx ON reminders (done_at DESC) WHERE done_at IS NOT NULL;

-- ===== Layer 2 (0005_pa-memory): what is in motion =====
-- ---------- Commitments: todos, promises both ways, decisions ----------
-- kind: 'todo' (mine, no counterparty needed), 'i_owe' (I promised someone),
-- 'waiting_on' (someone promised me), 'decision' (recorded, not a loop).
-- person_id is the counterparty: owed to / waiting on / decided with.
CREATE TABLE commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo', 'i_owe', 'waiting_on', 'decision')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  due_on DATE,                 -- calendar date; due/overdue judged in the owner's zone
  notes TEXT NOT NULL DEFAULT '', -- context; the rationale for a decision
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  source TEXT,
  source_ref TEXT,
  source_quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  done_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commitments_open_idx ON commitments (due_on NULLS LAST, created_at)
  WHERE status = 'open' AND archived_at IS NULL;
CREATE INDEX commitments_person_idx ON commitments (person_id) WHERE archived_at IS NULL;
CREATE INDEX commitments_done_idx ON commitments (done_at DESC) WHERE status = 'done';
CREATE INDEX commitments_archived_idx ON commitments (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Interactions: every time you actually spoke ----------
-- Logging one moves each linked person's last_contacted_at forward (lib/db.ts).
CREATE TABLE interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL DEFAULT 'other' CHECK (channel IN ('meeting', 'call', 'message', 'email', 'in_person', 'other')),
  summary TEXT NOT NULL DEFAULT '',
  source TEXT,
  source_ref TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX interactions_at_idx ON interactions (at DESC) WHERE archived_at IS NULL;
CREATE INDEX interactions_archived_idx ON interactions (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE interaction_people (
  interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, person_id)
);
CREATE INDEX interaction_people_person_idx ON interaction_people (person_id);

-- ---------- Facts: small true things, with history ----------
-- One current value per (subject, key): adding a fact with the same key
-- supersedes the old one (superseded_at set) rather than overwriting it.
-- subject_kind 'me' is the owner's own profile (subject_id null).
CREATE TABLE facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('me', 'person', 'place', 'organisation')),
  subject_id UUID,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  source_ref TEXT,
  source_quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES facts(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((subject_kind = 'me') = (subject_id IS NULL))
);
CREATE INDEX facts_current_idx ON facts (subject_kind, subject_id, lower(key))
  WHERE superseded_at IS NULL AND archived_at IS NULL;
CREATE INDEX facts_archived_idx ON facts (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Identities: how to recognise a person in other systems ----------
-- Values are normalised on write (emails lowercased, phones digits only, names
-- trimmed + lowercased) so agents can resolve "priya@acme.com" or a Slack
-- handle to one person. people.email/phone are also checked when resolving.
CREATE TABLE identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'slack', 'alias', 'other')),
  value TEXT NOT NULL,                       -- encrypted (0012); matched via value_bidx
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  value_bidx TEXT,                           -- blind index (0012): an alias like a name, a phone by its last ten digits
  UNIQUE (kind, value)
);
CREATE INDEX identities_person_idx ON identities (person_id);
CREATE INDEX identities_value_bidx_idx ON identities (kind, value_bidx);

-- ---------- Suggestions: the review inbox ----------
-- What an agent wasn't sure enough to write directly. Accepting applies
-- `payload` through the normal db layer; rejecting keeps the row (so the same
-- suggestion isn't filed again) and changes nothing else.
CREATE TABLE suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'booking' and 'purchase' added in 0015.
  op TEXT NOT NULL CONSTRAINT suggestions_op_check
    CHECK (op IN ('commitment', 'fact', 'interaction', 'event', 'person', 'link', 'booking', 'purchase')),
  summary TEXT NOT NULL,       -- one human sentence: "You owe Priya the intro deck"
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT,
  source_ref TEXT,
  source_quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  result_id UUID,              -- what accepting created/updated
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suggestions_pending_idx ON suggestions (created_at DESC) WHERE status = 'pending';

-- ---------- Life admin: things that renew or expire ----------
-- Never store ID, policy or account numbers here: those belong in
-- sensitive_blobs (ciphertext). renews_on feeds Coming up and reminders.
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('passport', 'licence', 'insurance', 'vehicle', 'warranty', 'subscription', 'home', 'pet', 'health', 'other')),
  provider TEXT NOT NULL DEFAULT '',
  renews_on DATE,              -- renewal or expiry date (a calendar date)
  remind_days_before INT[] NOT NULL DEFAULT '{30,7,0}',
  notes TEXT NOT NULL DEFAULT '',
  sensitive_blob_id UUID REFERENCES sensitive_blobs(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assets_renews_idx ON assets (renews_on) WHERE archived_at IS NULL;
CREATE INDEX assets_archived_idx ON assets (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Watch & read (books, films, TV shows, music, games, …) ----------
-- Called the reading list until 0014; the table and its status values
-- (queued / reading / done) kept their names. The app words each status
-- for the kind: To watch / Watching / Watched, To read / Reading / Read, …
CREATE TABLE reading_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'book', 'podcast', 'video', 'paper', 'other', 'film', 'tv', 'music', 'game')),
  author TEXT NOT NULL DEFAULT '', -- who made it: author, director, artist, the podcast's show, the game's studio
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'reading', 'done')),
  notes TEXT NOT NULL DEFAULT '', -- highlights and takeaways, Markdown
  recommended_by UUID REFERENCES people(id) ON DELETE SET NULL,
  finished_at TIMESTAMPTZ,
  source TEXT,
  sync JSONB, -- 0029: sealed; match keys and what a source last wrote (lib/watch-read-sync.ts)
  meta JSONB, -- 0063: sealed; year, running time, genres, playlists, tags (lib/watch-meta.ts)
  -- 0042: how far through it you are; plain numbers, like goals.progress (lib/watch-read.ts).
  -- 'page' or 'episode' with an optional total, or 'percent' (0–100, no total); all null = not kept.
  progress_unit TEXT,
  progress_done INT,
  progress_total INT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reading_items_progress_check CHECK (
    -- A CASE, so a NULL can't make the check pass by default.
    CASE
      WHEN progress_unit IS NULL THEN progress_done IS NULL AND progress_total IS NULL
      WHEN progress_unit = 'percent' THEN progress_done IS NOT NULL AND progress_done BETWEEN 0 AND 100 AND progress_total IS NULL
      WHEN progress_unit IN ('page', 'episode') THEN progress_done IS NOT NULL AND progress_done >= 0
        AND (progress_total IS NULL OR (progress_total >= 1 AND progress_done <= progress_total))
      ELSE false
    END
  )
);
CREATE INDEX reading_items_live_idx ON reading_items (status, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX reading_items_archived_idx ON reading_items (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Goals ----------
CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'quarter' CHECK (period IN ('week', 'month', 'quarter', 'year')),
  target TEXT NOT NULL DEFAULT '',   -- what "done" looks like, in words
  progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dropped')),
  due_on DATE,
  notes TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX goals_live_idx ON goals (status, due_on NULLS LAST) WHERE archived_at IS NULL;
CREATE INDEX goals_archived_idx ON goals (archived_at DESC) WHERE archived_at IS NOT NULL;

-- Every change to a goal's progress, newest last (0041). 'seed' rows hold the value
-- each goal had when the log began. Read by the week and month in review (lib/week-review.ts).
CREATE TABLE goal_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  progress INT NOT NULL CHECK (progress BETWEEN 0 AND 100),
  source TEXT NOT NULL DEFAULT 'change' CHECK (source IN ('seed', 'change')),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX goal_progress_goal_at_idx ON goal_progress (goal_id, at DESC);

-- ---------- Ranked full-text search over notes ----------
-- 0005 added a full-text index (athena_note_tsv + notes_fts_idx); 0012
-- dropped both. Content is encrypted at rest (SECURITY.md §11), so recall
-- decrypts and ranks in the Function (lib/text-search.ts).

-- ---------- Custom fields: the owner's own details on any kind of record (0016) ----------
-- "Shoe size" and "Interests" on people, "Rating" on the reading list. Defined
-- per kind in Settings (or through Ask), archived but never deleted. Labels,
-- units, options and values are sealed like other content (SECURITY.md §11),
-- so labels are matched and values searched in the Function, never in SQL.
-- kind / entity_kind are a kind string, not a fixed list: a new kind needs no
-- migration, and owner-made kinds can later use ids like 'custom:<uuid>'.
CREATE TABLE custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_:-]{0,79}$'),  -- 'person', 'reading', 'note', …
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'long_text', 'number', 'rating', 'boolean', 'date', 'link', 'choice', 'choices')),
  options JSONB NOT NULL DEFAULT '[]',   -- choice / choices: a JSON array, or one sealed JSON string
  unit TEXT NOT NULL DEFAULT '',         -- number: 'UK', 'cm', …
  position INT NOT NULL DEFAULT 0,       -- the owner's order within the kind
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_fields_kind_idx ON custom_fields (kind, position) WHERE archived_at IS NULL;

-- One value per field per record, as (sealed) JSON text; no row = no value.
-- Permanently deleting a record deletes its values with its edges (lib/db.ts).
CREATE TABLE custom_values (
  field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind ~ '^[a-z][a-z0-9_:-]{0,79}$'),
  entity_id UUID NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX custom_values_entity_idx ON custom_values (entity_kind, entity_id);

-- ===== 0018_custom-kinds: the owner's own kinds of record, and their records =====
-- A kind's fields and values are custom_fields / custom_values with kind
-- 'custom:<kind id>'. name, one, title and body are sealed (SECURITY.md §11).
CREATE TABLE custom_kinds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,             -- plural, as shown: "Wines"
  one TEXT NOT NULL,              -- singular, for sentences: "wine"
  icon TEXT NOT NULL DEFAULT 'folder' CHECK (icon ~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'),
  position INT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_kinds_live_idx ON custom_kinds (position) WHERE archived_at IS NULL;

CREATE TABLE custom_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind_id UUID NOT NULL REFERENCES custom_kinds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',  -- Markdown; athena:// links become 'record' content edges
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_records_kind_idx ON custom_records (kind_id) WHERE archived_at IS NULL;
CREATE INDEX custom_records_archived_idx ON custom_records (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ===== 0006_connectors (+ 0007–0009): accounts Athena signs in to, and scheduled collections =====

-- ---------- Connectors: one row per signed-in account ----------
CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What you call it: "Work Gmail".
  name TEXT NOT NULL,
  -- A preset key from lib/connector-presets.ts ('gmail', 'linear', …) or 'custom'.
  provider TEXT NOT NULL DEFAULT 'custom',
  -- Which identity this is ('work', 'personal', or ''): suggested as the
  -- label for collections that read from it.
  account_label TEXT NOT NULL DEFAULT '',
  -- The MCP server's Streamable HTTP endpoint.
  url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('oauth', 'token', 'none')),
  -- OAuth scope to request ('' = whatever the server advertises).
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'needs_auth', 'error')),
  status_detail TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM ciphertext (lib/secret-box.ts) of a JSON object holding
  -- every secret for this account: static token, OAuth client registration,
  -- access/refresh tokens, PKCE verifier. Never returned by the API.
  credentials TEXT,
  -- SHA-256 of the OAuth `state` while a sign-in is in flight (cleared on
  -- callback). The raw state only ever exists in the user's browser redirect.
  oauth_state_hash TEXT UNIQUE,
  oauth_state_expires_at TIMESTAMPTZ,
  -- Tools the server offers: [{ name, description, access: 'read'|'write'|'unknown' }].
  tools JSONB NOT NULL DEFAULT '[]',
  -- The only tools a collection may call. Write tools can never be added.
  allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  tools_checked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What the server says about itself: title, version, description, website, and a
  -- logo as data: URIs (light/dark), fetched server-side. (0005)
  server_info JSONB NOT NULL DEFAULT '{}',
  -- Non-secret OAuth settings for servers that need them: grant
  -- ('authorization_code' | 'client_credentials'), authorization/token URLs
  -- entered by hand, client auth method, audience. '{}' = discover. (0011)
  oauth JSONB NOT NULL DEFAULT '{}',
  -- Google Calendar and Outlook: the calendar ids Athena reads. NULL = only
  -- the main one (0030). iCloud keeps its choice in `scope`.
  calendars TEXT[],
  -- Gmail and Outlook: which emails Athena reads (lib/mail-rules.ts), one
  -- JSON value sealed under the data key. NULL = no rules. (0043)
  mail_rules TEXT CONSTRAINT connectors_mail_rules_sealed CHECK (mail_rules IS NULL OR mail_rules LIKE 'enc:v1:%'),
  -- Notion: "Let Athena create pages" under this page (0047). The title is sealed.
  write_parent_id TEXT,
  write_parent_title TEXT NOT NULL DEFAULT '',
  -- Custom MCP servers (0060): each allowed tool's text hash (description +
  -- input schema) when the owner allowed it, { "<tool>": "<sha256>" }; a tool
  -- whose text changed is kept from the model until approved again. NULL on
  -- accounts older than 0060: pinned at their current text on the next listing.
  tool_pins JSONB DEFAULT '{}',
  -- Custom MCP servers (0060), both off by default: offer its tools to Ask's
  -- answers; let it share a collection with other accounts.
  use_in_ask BOOLEAN NOT NULL DEFAULT false,
  share_collections BOOLEAN NOT NULL DEFAULT false
);
-- Emails the rules kept from collection runs, per account and day: counts only. (0043)
CREATE TABLE mail_skips (
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  n INT NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (connector_id, day)
);
-- An event's calendar account (0027): set when a collection syncs an invite.
ALTER TABLE events ADD CONSTRAINT events_calendar_connector_id_fkey FOREIGN KEY (calendar_connector_id) REFERENCES connectors(id) ON DELETE SET NULL;

-- ---------- Collections: what to collect, from which accounts, when ----------
CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- A recipe from netlify/lib/connectors/recipes.ts, or 'custom' (instructions only).
  recipe TEXT NOT NULL CHECK (recipe IN ('calendar-meetings', 'email-digest', 'work-activity', 'life-log', 'plays-watches', 'work-sync', 'home', 'custom')),
  connector_ids UUID[] NOT NULL DEFAULT '{}',
  -- '' or e.g. 'personal': makes source 'email-digest-personal' and metric
  -- names '..._personal', so two accounts never merge or dedupe each other.
  label TEXT NOT NULL DEFAULT '',
  -- notes.source for everything this collection writes.
  source TEXT NOT NULL,
  -- Extra guidance (required for 'custom').
  instructions TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT 'daily' CHECK (schedule IN ('daily', 'hourly', 'manual')),
  -- 'daily': local time in the owner's zone (settings.timezone).
  run_at TIME,
  -- 'hourly': every N hours.
  every_hours INT CHECK (every_hours IS NULL OR every_hours BETWEEN 1 AND 168),
  lookback_hours INT NOT NULL DEFAULT 36 CHECK (lookback_hours BETWEEN 1 AND 336),
  -- Sync upcoming calendar events into `events` this many days ahead (0 = off), and push before them. (0006)
  lookahead_days INT NOT NULL DEFAULT 0 CHECK (lookahead_days BETWEEN 0 AND 60),
  event_push BOOLEAN NOT NULL DEFAULT false,
  -- Skip a run when the precheck finds nothing new (on), or always run (off). (0022)
  skip_quiet BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collections_due_idx ON collections (next_run_at) WHERE enabled AND schedule <> 'manual';

-- ---------- Runs: one per execution, kept as history ----------
-- Your work, counted (migration 0067, lib/work.ts): the owner's own Linear issues and GitHub PRs,
-- read by the work sync with no model. One sealed value per item; the key is a hash of its id.
CREATE TABLE work_items (
  source TEXT NOT NULL CHECK (source IN ('linear', 'github')),
  item_key TEXT NOT NULL CHECK (item_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, item_key)
);

CREATE TABLE collection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- The model's closing summary (counts, not content).
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  -- { tool_calls, notes_created, notes_updated, metrics, people, input_tokens, output_tokens, … }
  stats JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collection_runs_collection_idx ON collection_runs (collection_id, created_at DESC);
CREATE INDEX collection_runs_open_idx ON collection_runs (created_at) WHERE status IN ('queued', 'running');

-- ---------- What each source item became (0004, reworked in 0006) ----------
-- (source, kind, external_id) — e.g. ('calendar-meetings-work', 'event', '<event id>')
-- — so a rerun updates what it wrote before, a cancelled item's record can be
-- archived, and something you archived or deleted isn't written again. No
-- foreign key on purpose: a deleted record's mapping is how that's remembered.
CREATE TABLE collected_items (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  record_id UUID NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'event')),
  -- true = archived by the collector because the source item went away
  archived_by_collector BOOLEAN NOT NULL DEFAULT false,
  item_date DATE, -- the source item's date in the owner's zone
  title TEXT NOT NULL DEFAULT '',
  run_id UUID, -- the run that last saved it; null for imports and older items (0026)
  PRIMARY KEY (source, kind, external_id)
);
CREATE INDEX collected_items_window_idx ON collected_items (source, kind, item_date);
CREATE INDEX collected_items_run_idx ON collected_items (run_id) WHERE run_id IS NOT NULL;

-- Owner preferences (0007). `timezone`: the IANA zone the owner's device last
-- reported; the server's "today", due dates, reminders, 07:30 briefing and
-- "daily at" times use it. `reminder_timezone`: the zone pending repeating
-- reminders are lined up with (lib/db.ts alignReminders; missing = Europe/London).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== 0015_trips-purchases: trips and purchases, from booking and order emails (lib/trips.ts) =====
-- Free text is encrypted at rest; references, order and tracking numbers are
-- matched by blind index. Dates, instants, kinds and statuses stay readable.

-- ---------- Trips: a journey, named after where it's to ----------
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,                          -- where it's to: "Lisbon"
  starts_on DATE,                               -- first local day of its live bookings
  ends_on DATE,                                 -- last local day
  notes TEXT NOT NULL DEFAULT '',
  source TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trips_live_dates_idx ON trips (ends_on, starts_on) WHERE archived_at IS NULL;
CREATE INDEX trips_archived_idx ON trips (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Bookings: flights, trains, hotel stays, car hire, tickets ----------
-- Instants are UTC; each end keeps the IANA zone of where it happens, so times
-- are shown in the place's own time. A moved start keeps the old one.
CREATE TABLE trip_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('flight', 'train', 'hotel', 'car', 'event', 'other')),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'changed', 'cancelled')),
  title TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  reference_bidx TEXT,                          -- blind index of the normalised reference
  segment TEXT NOT NULL DEFAULT '',             -- "outbound", "return": which part of a booking with several
  start_date DATE NOT NULL,
  starts_at TIMESTAMPTZ,
  start_tz TEXT NOT NULL DEFAULT '',
  start_place TEXT NOT NULL DEFAULT '',
  start_city TEXT NOT NULL DEFAULT '',
  end_date DATE,
  ends_at TIMESTAMPTZ,
  end_tz TEXT NOT NULL DEFAULT '',
  end_place TEXT NOT NULL DEFAULT '',
  end_city TEXT NOT NULL DEFAULT '',
  seat TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  email_link TEXT NOT NULL DEFAULT '',
  previous_starts_at TIMESTAMPTZ,
  owner_edited TEXT[] NOT NULL DEFAULT '{}',   -- fields you changed by hand; emails leave them alone (0020)
  cancelled_at TIMESTAMPTZ,                      -- when an email cancelled it (0020)
  cancel_email_link TEXT NOT NULL DEFAULT '',    -- link to that email, sealed (0020)
  source TEXT,
  source_ref TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trip_bookings_trip_idx ON trip_bookings (trip_id);
CREATE INDEX trip_bookings_reference_idx ON trip_bookings (reference_bidx);
CREATE INDEX trip_bookings_live_starts_idx ON trip_bookings (starts_at) WHERE archived_at IS NULL AND starts_at IS NOT NULL;
CREATE INDEX trip_bookings_archived_idx ON trip_bookings (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Purchases: an order and where its delivery has got to ----------
-- Never a price, total or card detail (SECURITY.md §1). Settled ones are
-- archived by Athena 30 days on (archived_by_athena); one you restore stays.
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer TEXT NOT NULL,
  items TEXT[] NOT NULL DEFAULT '{}',
  order_number TEXT NOT NULL DEFAULT '',
  order_bidx TEXT,
  ordered_on DATE,
  status TEXT NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('ordered', 'dispatched', 'out_for_delivery', 'delivered', 'delayed', 'returned', 'refunded', 'cancelled')),
  status_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_on DATE,
  delivered_at TIMESTAMPTZ,
  carrier TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  tracking_bidx TEXT,
  tracking_url TEXT NOT NULL DEFAULT '',
  email_link TEXT NOT NULL DEFAULT '',
  source TEXT,
  source_ref TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  archived_by_athena BOOLEAN NOT NULL DEFAULT false,
  stay_visible BOOLEAN NOT NULL DEFAULT false,
  owner_edited TEXT[] NOT NULL DEFAULT '{}',   -- fields you changed by hand; emails leave them alone (0020)
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX purchases_order_idx ON purchases (order_bidx);
CREATE INDEX purchases_tracking_idx ON purchases (tracking_bidx);
CREATE INDEX purchases_live_idx ON purchases (status, status_at) WHERE archived_at IS NULL;
CREATE INDEX purchases_archived_idx ON purchases (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- A purchase's timeline ----------
CREATE TABLE purchase_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('ordered', 'dispatched', 'out_for_delivery', 'delivered', 'delayed', 'returned', 'refunded', 'cancelled')),
  at TIMESTAMPTZ NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  email_link TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX purchase_updates_purchase_idx ON purchase_updates (purchase_id, at);

-- ---------- Ask: every conversation (0017) ----------
-- One row per conversation; the app makes the id. `title` '' = named from the first
-- message. `messages` is one JSON array (sealed as one JSON string): the
-- owner's words, assistant replies and the turns sent, and search answers as
-- references (question, keywords, ids and kinds), never copies of note text.
-- updated_at: the device's time of the last change (newest wins);
-- synced_at: the server's time of the last write (what pulls read from).
-- archived_at: archived from Ask (syncs like any change); the Archived page
-- restores it or deletes it for good (removes the row). App only, not in MCP.
CREATE TABLE ask_threads (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ask_threads_synced_idx ON ask_threads (synced_at);

-- ---------- Files: photos, PDFs and text in Ask and on notes (0019) ----------
-- Bytes in Netlify Blobs ("athena-files"), sealed under ATHENA_DATA_KEY; no
-- public URLs. `name`, `summary` and `extracted_text` are sealed; type,
-- size, pixel size, pages readable. Summary and text are written on first read.
-- Kept while a note (note_files) or an Ask conversation (thread_files) uses it.
CREATE TABLE files (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/markdown', 'text/plain')),
  size INT NOT NULL CHECK (size > 0),
  width INT,
  height INT,
  pages INT,
  has_thumb BOOLEAN NOT NULL DEFAULT false,
  key_id TEXT NOT NULL,
  summary TEXT,
  extracted_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE note_files (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, file_id)
);
CREATE INDEX note_files_file_idx ON note_files (file_id);

CREATE TABLE thread_files (
  thread_id UUID NOT NULL,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A picture Ask made, undone (0078): out of the conversation, on the Archived page.
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (thread_id, file_id)
);
CREATE INDEX thread_files_file_idx ON thread_files (file_id);
CREATE INDEX thread_files_archived_idx ON thread_files (archived_at) WHERE archived_at IS NOT NULL;

-- Days (0032, lib/days.ts): one row per day (the line, sealed like note text; mood and
-- journal sealed together under the data key), what happened as entries, and photos.
CREATE TABLE days (
  date DATE PRIMARY KEY,
  line TEXT,
  line_by TEXT CHECK (line_by IN ('run', 'owner')),
  line_run UUID,
  private TEXT CHECK (private IS NULL OR private LIKE 'enc:v1:%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX days_updated_idx ON days (updated_at);

CREATE TABLE day_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('watched', 'listened', 'read', 'highlight', 'played', 'posted', 'saved', 'chess', 'workout', 'habit', 'other')),
  source TEXT NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,29}$'),
  external_id TEXT NOT NULL,
  ext_key TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  url TEXT,
  grp TEXT,
  note TEXT,
  at TIMESTAMPTZ,
  rating NUMERIC(2, 1) CHECK (rating IS NULL OR (rating >= 0.5 AND rating <= 5)),
  count INT NOT NULL DEFAULT 1 CHECK (count >= 0),  -- 0: a skipped habit (migration 0034)
  minutes INT CHECK (minutes IS NULL OR minutes >= 0),
  art JSONB,
  hours TEXT,                -- plays per local hour, 24 counts as sealed JSON (migration 0062)
  position INT NOT NULL DEFAULT 0,
  folded_into UUID REFERENCES day_entries(id) ON DELETE SET NULL,
  collection TEXT,
  run_id UUID,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX day_entries_key_idx ON day_entries (source, ext_key);
CREATE INDEX day_entries_date_idx ON day_entries (date);
CREATE INDEX day_entries_run_idx ON day_entries (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE day_files (
  date DATE NOT NULL,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, file_id)
);
CREATE INDEX day_files_file_idx ON day_files (file_id);

-- Artwork for Days and Watch & read (migration 0033, lib/art.ts): the bytes
-- are sealed in Netlify Blobs; ids and sources are blind indexes.
CREATE TABLE art (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  w INTEGER NOT NULL CHECK (w > 0),
  h INTEGER NOT NULL CHECK (h > 0),
  tone TEXT CHECK (tone ~ '^#[0-9a-f]{6}$'),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  kid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE art_sources (
  source_hash TEXT PRIMARY KEY,
  art_id TEXT REFERENCES art(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX art_sources_art_id ON art_sources (art_id);

-- The owner's own habits (migration 0036; lib/own-habits.ts). name and unit sealed; ticks are 'habit' day_entries with source 'athena'.
CREATE TABLE habits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  days SMALLINT NOT NULL DEFAULT 127 CHECK (days BETWEEN 0 AND 127),  -- Monday = 1 … Sunday = 64
  per_week SMALLINT CHECK (per_week IS NULL OR per_week BETWEEN 1 AND 7),
  target INT CHECK (target IS NULL OR target BETWEEN 2 AND 1000),
  unit TEXT,
  icon TEXT NOT NULL DEFAULT 'check' CHECK (icon ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  position INT NOT NULL DEFAULT 0,
  starts_on DATE NOT NULL DEFAULT CURRENT_DATE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT habits_due_check CHECK (per_week IS NOT NULL OR days > 0)
);
CREATE INDEX habits_live_idx ON habits (position) WHERE archived_at IS NULL;

-- To-do contexts (migration 0037; lib/todo-context.ts, lib/todo-contexts.ts). Names, icons and colours readable; archived ones read as blank.
CREATE TABLE todo_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('area', 'where')),
  key TEXT CHECK (key IS NULL OR key ~ '^[a-z_]{1,30}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  icon TEXT NOT NULL DEFAULT 'tag' CHECK (icon ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  colour TEXT NOT NULL DEFAULT 'grey' CHECK (colour IN ('grey', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'violet')),
  position INT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX todo_contexts_key_idx ON todo_contexts (kind, key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX todo_contexts_name_idx ON todo_contexts (kind, lower(name)) WHERE archived_at IS NULL;
-- Starter set: see the migration's INSERT (and STARTER_CONTEXTS in lib/todo-context.ts).

ALTER TABLE commitments
  ADD COLUMN area_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  ADD COLUMN where_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  ADD COLUMN context_by_athena BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX commitments_area_idx ON commitments (area_id) WHERE area_id IS NOT NULL;
CREATE INDEX commitments_where_idx ON commitments (where_id) WHERE where_id IS NOT NULL;

-- A to-do's details (migration 0084; lib/todo-details.ts). steps and links are each one sealed JSON value; priority 0 none to 3 high.
ALTER TABLE commitments
  ADD COLUMN steps JSONB,
  ADD COLUMN links JSONB,
  ADD COLUMN priority SMALLINT NOT NULL DEFAULT 0 CONSTRAINT commitments_priority_check CHECK (priority BETWEEN 0 AND 3);

-- The owner's last context correction per sender ('person:<uuid>') or source ('source:<source>').
CREATE TABLE todo_context_hints (
  key TEXT PRIMARY KEY CHECK (key ~ '^(person|source):.{1,200}$'),
  area_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  where_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved (migration 0038; lib/saved.ts). url, title, site, author, excerpt, readable, quote, note, tags, source_url sealed; images sealed in the athena-saved blob store.
CREATE TABLE saved_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('link', 'image', 'quote', 'snippet', 'note')),
  client_id UUID UNIQUE,
  url TEXT,
  url_bidx TEXT,
  title TEXT,
  site TEXT,
  author TEXT,
  published_on DATE,
  excerpt TEXT,
  readable TEXT,
  words INT,
  quote TEXT,
  note TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('shortcut', 'extension', 'share-target', 'app', 'email')),
  source_url TEXT,
  has_image BOOLEAN NOT NULL DEFAULT false,
  image_w INT,
  image_h INT,
  image_tone TEXT CHECK (image_tone IS NULL OR image_tone ~ '^#[0-9a-f]{6}$'),
  image_kid TEXT,
  fetch_status TEXT CHECK (fetch_status IS NULL OR fetch_status IN ('ok', 'preview', 'failed')),
  fetched_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_on DATE NOT NULL DEFAULT CURRENT_DATE,
  -- 0039: what it is (lib/saved-kinds.ts), its facts (sealed JSON), and where an action filed it (sealed JSON).
  thing TEXT CHECK (thing IS NULL OR thing IN ('book', 'film', 'show', 'product', 'recipe', 'place', 'event', 'article', 'video', 'image')),
  facts TEXT,
  filed_at TIMESTAMPTZ,
  filed_to TEXT,
  archived_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX saved_items_live_idx ON saved_items (saved_at DESC) WHERE archived_at IS NULL;
CREATE INDEX saved_items_day_idx ON saved_items (saved_on);
CREATE INDEX saved_items_filed_idx ON saved_items (filed_at DESC) WHERE filed_at IS NOT NULL;
CREATE TABLE saved_rate (
  bucket TEXT NOT NULL,
  minute TIMESTAMPTZ NOT NULL,
  n INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, minute)
);
CREATE INDEX saved_items_url_idx ON saved_items (url_bidx) WHERE url_bidx IS NOT NULL;

-- Tracking (migration 0073; lib/trackers.ts, lib/trackers-store.ts, contract lib/tracker-types.ts): anything followed over
-- time, a number or a state, on a saved item or on its own. name, url, label, prefix, suffix, states and target_value
-- sealed; kinds, presets, the currency, times and who set or checked readable. removed_at is Undo.
CREATE TABLE trackers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_id UUID REFERENCES saved_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  url TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('number', 'state')),
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  currency TEXT CHECK (currency ~ '^[A-Z]{3}$'),
  states TEXT[] NOT NULL DEFAULT '{}',
  direction TEXT NOT NULL CHECK (direction IN ('lower', 'higher', 'change')),
  preset TEXT CHECK (preset IN ('price', 'stock')),
  target_op TEXT CHECK (target_op IN ('lte', 'gte', 'eq', 'change')),
  target_value TEXT,
  target_set_by TEXT CHECK (target_set_by IN ('owner', 'ask', 'assistant')),
  target_assistant_id UUID,
  target_set_at TIMESTAMPTZ,
  assistant_id UUID,
  -- Who chose the checker (0074): NULL nobody yet, so the first assistant to keep a check takes it on; 'owner' never overwritten.
  assistant_set_by TEXT CHECK (assistant_set_by IN ('owner', 'ask', 'assistant')),
  -- Who set the link (0085): 'owner' typed or approved it, 'item' the saved item's own; only those are opened by a run.
  url_set_by TEXT CHECK (url_set_by IN ('owner', 'item', 'ask', 'assistant')),
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'state' OR states = '{}'),
  CHECK (preset IS DISTINCT FROM 'price' OR currency IS NOT NULL)
);
CREATE INDEX trackers_item_idx ON trackers (saved_id) WHERE removed_at IS NULL;
CREATE INDEX trackers_assistant_idx ON trackers (assistant_id) WHERE removed_at IS NULL AND assistant_id IS NOT NULL;
CREATE UNIQUE INDEX trackers_item_preset_idx ON trackers (saved_id, preset) WHERE saved_id IS NOT NULL AND preset IS NOT NULL AND removed_at IS NULL;
-- One row per check (0073), kept forever. value, source and url sealed. Ask's and an assistant's checks carry their page's link.
CREATE TABLE tracker_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id UUID NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  source TEXT,
  url TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_by TEXT NOT NULL CHECK (checked_by IN ('save', 'owner', 'ask', 'assistant')),
  assistant_id UUID,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (checked_by IN ('owner', 'save') OR url IS NOT NULL)
);
CREATE INDEX tracker_points_idx ON tracker_points (tracker_id, checked_at) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX tracker_points_save_idx ON tracker_points (tracker_id) WHERE checked_by = 'save';

-- Link previews for rich links (migration 0040; lib/link-previews.ts). A cache keyed by a blind index of the normalised address;
-- the address isn't kept. title, summary, site_name, author, kind, facts sealed; picture and favicon sealed in the athena-link-previews blob store.
CREATE TABLE link_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url_bidx TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  title TEXT,
  summary TEXT,
  site_name TEXT,
  author TEXT,
  kind TEXT,
  facts TEXT,
  has_image BOOLEAN NOT NULL DEFAULT false,
  image_w INT,
  image_h INT,
  image_tone TEXT CHECK (image_tone IS NULL OR image_tone ~ '^#[0-9a-f]{6}$'),
  image_kid TEXT,
  has_favicon BOOLEAN NOT NULL DEFAULT false,
  favicon_kid TEXT,
  fetched_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX link_previews_checked_idx ON link_previews (checked_at);

-- ---------- Templates and documents Athena writes (0047) ----------

-- The owner's templates: Markdown with {{fields}}. The six starters live in
-- code (lib/templates.ts); editing one saves a row with its key in `starter`.
-- Names and bodies are sealed under the data key (§11).
CREATE TABLE IF NOT EXISTS note_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  starter TEXT,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS note_templates_starter_idx ON note_templates (starter) WHERE starter IS NOT NULL AND archived_at IS NULL;

-- Every doc and page Athena made. This is the list of what it may change
-- later (fill again, trash, clear): never anything else in the account.
CREATE TABLE IF NOT EXISTS document_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google-docs', 'notion')),
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  -- 'doc' or 'page'; 'folder' for the Athena folder in Drive.
  kind TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc', 'page', 'folder')),
  external_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Undo: trashed in Drive, or cleared in Notion.
  undone_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS document_exports_external_idx ON document_exports (connector_id, external_id);
CREATE INDEX IF NOT EXISTS document_exports_note_idx ON document_exports (note_id, created_at DESC);

-- ---------- Events Athena added to a calendar (0048) ----------

-- One row per event Athena added, after the owner confirmed it. This list is
-- the only thing Undo may delete. Ids only: no title, time or guests.
CREATE TABLE IF NOT EXISTS calendar_creates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_creates_event_idx ON calendar_creates (connector_id, calendar_id, event_id);

-- ---------- Nudges Athena starts (0051, lib/proactive/) ----------
-- One row per nudge made. `key` dedupes (ids and times only); everything
-- readable is in `payload`, sealed under the data key.
CREATE TABLE IF NOT EXISTS nudges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  local_day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  pushed_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  applied JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS nudges_day_idx ON nudges (local_day);
CREATE INDEX IF NOT EXISTS nudges_live_idx ON nudges (expires_at) WHERE dismissed_at IS NULL;
-- "Fewer like this": a rule muted until a time. No content.
CREATE TABLE IF NOT EXISTS nudge_mutes (
  rule TEXT PRIMARY KEY,
  muted_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Recipes, the week's dinners and the grocery list (0053) ----------

-- A recipe. The owner's words and the page's (title, address, the body with
-- ingredients, steps and notes as one JSON value, tags) are sealed under the
-- data key. Readable: minutes and servings (filters and the week plan), how
-- it was read, dates. url_bidx is a blind index of the page's canonical
-- address, so the same recipe imported twice is one. saved_id points at the
-- Saved item it came from: its page, readable copy and photo stay there.
CREATE TABLE recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_id UUID REFERENCES saved_items(id) ON DELETE SET NULL,
  url TEXT,
  url_bidx TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  total_minutes INT,
  servings INT,
  parse TEXT NOT NULL DEFAULT 'manual' CHECK (parse IN ('json-ld', 'microdata', 'model', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_url_idx ON recipes (url_bidx) WHERE url_bidx IS NOT NULL AND archived_at IS NULL;
-- One recipe per Saved item, archived or not: moving Saved's recipe links in runs once per item.
CREATE UNIQUE INDEX IF NOT EXISTS recipes_saved_idx ON recipes (saved_id) WHERE saved_id IS NOT NULL;

-- "Mark as cooked": one row per recipe and day.
CREATE TABLE recipe_cooked (
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, cooked_on)
);
CREATE INDEX IF NOT EXISTS recipe_cooked_on_idx ON recipe_cooked (cooked_on DESC);

-- The week's dinners: one row per evening the owner kept a plan for.
CREATE TABLE meal_plan (
  day DATE PRIMARY KEY,
  recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL,
  servings INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The grocery list: one list, kept in Athena. What to buy is sealed; the
-- amount, unit and aisle are readable (they name nothing without the item).
CREATE TABLE grocery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item TEXT NOT NULL,
  quantity NUMERIC,
  unit TEXT,
  aisle TEXT NOT NULL DEFAULT 'other',
  recipe_ids UUID[] NOT NULL DEFAULT '{}',
  own BOOLEAN NOT NULL DEFAULT false,
  ticked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_items_created_idx ON grocery_items (created_at);

-- ---------- History loaded on connect (0054) ----------

-- Rows a backfill wrote (netlify/lib/connectors/backfill.ts): in history and
-- the taste profile, never shown as new. Progress is in settings (history_load.<id>).
ALTER TABLE day_entries ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reading_items ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT false;

-- ---------- Ask plans, routines and what Ask did (0055) ----------

-- A plan: two or more changes Ask worked out and wrote nothing for yet. The
-- owner ticks the steps and taps Go; a routine's plan is only ever proposed.
-- The steps and what Go did are in `payload`, sealed.
CREATE TABLE IF NOT EXISTS ask_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'ask',
  thread_id UUID,
  routine_id UUID,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set once by Go: a plan runs at most once.
  ran_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ask_plans_created_idx ON ask_plans (created_at DESC);

-- A routine: a recurring Ask question ("Every Friday at 4pm: what slipped
-- this week?"). Its words are sealed in `payload`; when it runs (weekdays,
-- a time of day in the owner's zone) is plain, so the scheduler can read it.
-- `last_slot` is the slot it last ran for: one run per routine per slot.
CREATE TABLE IF NOT EXISTS ask_routines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  days SMALLINT[] NOT NULL,
  at_time TEXT NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT false,
  last_slot TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_thread_id UUID,
  -- The last run's nudge, sealed, until it goes out (it waits for quiet hours to end).
  pending TEXT,
  -- The last run's nudge went out (or was held for good): nothing left to deliver.
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What Ask did: one row per change Ask made, from a reply, a plan's Go, a
-- routine's plan or a nudge's card. The receipt (what it is, what happened,
-- Open and the Undo op) is in `payload`, sealed. `state` is done, undone or
-- undo_failed; `source` is ask, plan, routine or nudge.
CREATE TABLE IF NOT EXISTS ask_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  thread_id UUID,
  plan_id UUID,
  routine_id UUID,
  nudge_id UUID,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'done',
  state_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ask_activity_created_idx ON ask_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS ask_activity_plan_idx ON ask_activity (plan_id) WHERE plan_id IS NOT NULL;

-- The owner's Card and Mention choices for web links in notes Athena wrote
-- (migration 0059, lib/note-link-choices.ts). `payload` is sealed. Written
-- only by PUT /api/notes/:id/link-choices, from the app's editor.
CREATE TABLE IF NOT EXISTS note_link_choices (
  note_id UUID PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Ask's skills (0058) ----------

-- A skill: SKILL.md instructions that change how Ask handles some kinds of
-- question (lib/skills.ts). Its name, description, body, reference files and
-- where it came from are in `payload`, sealed. `starter` is the key of one of
-- the three Athena starts with; `uses` and `last_used_at` count Ask's uses.
CREATE TABLE IF NOT EXISTS ask_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  starter TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- A note's earlier versions (0061) ----------

-- What a note held before each change to its title or body, whoever made it
-- (the owner's typing grouped to one per 10 minutes): lib/note-versions.ts.
-- `title` and `body` are sealed like the note's; the newest 20 per note are kept.
CREATE TABLE IF NOT EXISTS note_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_versions_note_idx ON note_versions (note_id, created_at DESC);

-- ---------- Team: assistants, triggers, events and runs (0067) ----------

-- An assistant. Its words (name, job, instructions, personality, avatar) are
-- sealed in `payload`, and what it remembers (a summary of at most 2,000
-- characters and up to 30 facts) in `memory`, both like ask_routines.payload.
-- `allow` names the assistant tools it may run without asking; anything else
-- becomes a plan that waits for Go. `routine_id` is the routine it came from.
-- At most 12 (lib/team.ts).
CREATE TABLE IF NOT EXISTS team_assistants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  allow TEXT[] NOT NULL DEFAULT '{}',
  -- It may look things up online, while "Let Ask search the web" is on too; off by default (0072).
  web BOOLEAN NOT NULL DEFAULT false,
  -- Its own thinking and picture models, { think?, image? }; empty: the same as Ask. Plain (0077).
  models JSONB NOT NULL DEFAULT '{}',
  paused BOOLEAN NOT NULL DEFAULT false,
  routine_id UUID,
  memory TEXT,
  memory_updated_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_assistants_routine_idx ON team_assistants (routine_id) WHERE routine_id IS NOT NULL;

-- When an assistant runs: on weekdays at a time in the owner's zone
-- (`schedule`, like a routine), or when something arrives in Athena
-- (`event`, an EventFilter in `event`). Plain, so the reminders job can read
-- it. `last_slot` is the schedule slot it last ran for: one run per slot.
CREATE TABLE IF NOT EXISTS team_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES team_assistants (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'event')),
  days SMALLINT[],
  at_time TEXT,
  event JSONB,
  paused BOOLEAN NOT NULL DEFAULT false,
  last_slot TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_triggers_assistant_idx ON team_triggers (assistant_id);
CREATE INDEX IF NOT EXISTS team_triggers_kind_idx ON team_triggers (kind) WHERE NOT paused;

-- Something arrived in Athena that an event trigger may want: a collected
-- item, a saved link or gift idea, a tagged note. `facets` holds only what a
-- filter matches on (no secrets, no body text). The reminders job matches
-- unprocessed rows to triggers; rows are kept for 7 days.
CREATE TABLE IF NOT EXISTS team_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('collected', 'saved', 'note')),
  ref_id TEXT,
  ref_kind TEXT,
  facets JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_events_pending_idx ON team_events (created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS team_events_created_idx ON team_events (created_at);

-- One run of an assistant, from a trigger, an event or Run now. What it did,
-- in words, is sealed in `summary`; the conversation it kept is `thread_id`.
CREATE TABLE IF NOT EXISTS team_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES team_assistants (id) ON DELETE CASCADE,
  trigger_id UUID REFERENCES team_triggers (id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES team_events (id) ON DELETE SET NULL,
  -- Every event that matched in one pass, oldest first (0068); event_id is the first.
  event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  thread_id UUID,
  summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- What set it off and, while it works, what it's doing now (both sealed), when it last said so, and
  -- whether it found nothing to do (no card), and whether it's a second try after failing before anything ran (0071).
  label TEXT,
  step TEXT,
  step_at TIMESTAMPTZ,
  quiet BOOLEAN NOT NULL DEFAULT false,
  retried BOOLEAN NOT NULL DEFAULT false,
  -- The model it thought with, whether the chosen one failed so the default ran, and the one that failed (0077). Plain.
  model JSONB,
  fell_back BOOLEAN NOT NULL DEFAULT false,
  tried JSONB
);
CREATE INDEX IF NOT EXISTS team_runs_assistant_idx ON team_runs (assistant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS team_runs_open_idx ON team_runs (status) WHERE status IN ('queued', 'running');

-- ---------- An assistant's own skill (0069) ----------
-- Owned by one Team assistant: its turns always load it, main Ask never does, and it goes with the assistant.
ALTER TABLE ask_skills ADD COLUMN IF NOT EXISTS assistant_id UUID REFERENCES team_assistants(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS ask_skills_assistant_idx ON ask_skills (assistant_id) WHERE assistant_id IS NOT NULL;

-- A conversation that belongs to an assistant. Ask's own list hides these
-- unless it's filtered to that assistant.
ALTER TABLE ask_threads ADD COLUMN IF NOT EXISTS assistant_id UUID;
CREATE INDEX IF NOT EXISTS ask_threads_assistant_idx ON ask_threads (assistant_id) WHERE assistant_id IS NOT NULL;

-- ---------- Check-ins (0075) ----------
-- A morning preparation and an evening reflection, one row per (date, kind) (lib/checkins.ts). The day's plan and
-- its answers are sealed together; status and done_at stay readable for calendars and streaks. Settings are the
-- plain settings row 'checkins'.
CREATE TABLE IF NOT EXISTS checkins (
  date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, kind)
);
CREATE INDEX IF NOT EXISTS checkins_updated_idx ON checkins (updated_at);

-- ---------- 0076_assignments ----------

-- One piece of work passed along a line of assistants. The title and brief
-- are sealed in `payload`. `checkpoint` is the default its stages start
-- from; `suggestions` = 'take' answers a stage's questions as suggested
-- without stopping. `note_id` is the work product; `thread_id` the Ask
-- conversation it came from.
CREATE TABLE IF NOT EXISTS team_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'waiting', 'done', 'stopped', 'failed')),
  checkpoint TEXT NOT NULL DEFAULT 'auto' CHECK (checkpoint IN ('auto', 'approve')),
  suggestions TEXT NOT NULL DEFAULT 'ask' CHECK (suggestions IN ('ask', 'take')),
  sent_back BOOLEAN NOT NULL DEFAULT false,
  note_id UUID REFERENCES notes (id) ON DELETE SET NULL,
  thread_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_assignments_open_idx ON team_assignments (status) WHERE status IN ('running', 'waiting');

-- A guest: an assistant made for one assignment. No triggers, not on the
-- Team page, not counted toward the 12, gone with its assignment. "Keep on
-- the team" clears this column. `role` is its key in the role library.
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES team_assignments (id) ON DELETE CASCADE;
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS role TEXT;
CREATE INDEX IF NOT EXISTS team_assistants_assignment_idx ON team_assistants (assignment_id) WHERE assignment_id IS NOT NULL;

-- One assistant's turn at an assignment. `words` seals its task, handoff,
-- questions and answers (StageWords). `waits_for` says what it waits on.
CREATE TABLE IF NOT EXISTS team_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES team_assignments (id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  assistant_id UUID NOT NULL REFERENCES team_assistants (id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL DEFAULT 'auto' CHECK (checkpoint IN ('auto', 'approve')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'waiting', 'done', 'skipped', 'failed')),
  waits_for TEXT CHECK (waits_for IN ('go', 'answer', 'approval')),
  run_id UUID REFERENCES team_runs (id) ON DELETE SET NULL,
  note_version UUID,
  sent_back_from SMALLINT,
  words TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (assignment_id, position)
);
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES team_stages (id) ON DELETE SET NULL;

-- Team chat: one channel for the whole team. A post points at its run,
-- stage or assignment and never copies a plan. `body` is sealed.
-- `assistant_id` null with kind 'said' is the owner; null otherwise is Ask.
CREATE TABLE IF NOT EXISTS team_posts (
  id BIGSERIAL PRIMARY KEY,
  assistant_id UUID REFERENCES team_assistants (id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES team_assignments (id) ON DELETE CASCADE,
  stage_id UUID REFERENCES team_stages (id) ON DELETE CASCADE,
  run_id UUID REFERENCES team_runs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('lineup', 'update', 'handoff', 'question', 'plan', 'approval', 'done', 'failed', 'said', 'reply')),
  body TEXT NOT NULL,
  -- 'dismiss': a run that didn't finish, kept in the waiting strip until the owner dismisses it.
  waits_for TEXT CHECK (waits_for IN ('go', 'answer', 'approval', 'dismiss')),
  -- The conversation a `plan` or `reply` post's plan card lives in.
  thread_id UUID,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_posts_created_idx ON team_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS team_posts_assignment_idx ON team_posts (assignment_id, id) WHERE assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS team_posts_waiting_idx ON team_posts (id) WHERE waits_for IS NOT NULL AND settled_at IS NULL;

-- A note downloaded as Word is kept as a file (lib/files.ts).
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_type_check;
ALTER TABLE files ADD CONSTRAINT files_type_check CHECK (type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/markdown', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));

-- A file Athena made from a note (make_document), and the stage that made
-- it, so a made file is told from one the owner attached.
ALTER TABLE files ADD COLUMN IF NOT EXISTS made_from_note UUID REFERENCES notes (id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES team_stages (id) ON DELETE SET NULL;

-- AI spend (0079, lib/spend.ts): one row per model call, its cost in dollars at published prices, on the owner's day.
-- Plain. The budget is the settings row 'ai_budget', the exchange rates 'fx_rate'.
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  day DATE NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('ask', 'assistant', 'background', 'pictures')),
  assistant_id UUID,
  job TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  audio_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  usd NUMERIC(14, 8) NOT NULL CHECK (usd >= 0),
  estimated BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ai_usage_day_idx ON ai_usage (day);
CREATE INDEX IF NOT EXISTS ai_usage_assistant_day_idx ON ai_usage (assistant_id, day) WHERE assistant_id IS NOT NULL;

-- Flows (0080, lib/flows.ts, lib/flow-run.ts): a trigger and steps with branches. The owner's words are sealed in
-- flows.payload and flow_runs' label, summary, error and state; trigger kinds, schedules, statuses and ids are plain.
CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'event', 'before', 'manual')),
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  assistant_id UUID REFERENCES team_assistants (id) ON DELETE SET NULL,
  handed_at TIMESTAMPTZ,
  money BOOLEAN NOT NULL DEFAULT false,
  paused BOOLEAN NOT NULL DEFAULT false,
  origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'ask', 'draft', 'suggestion', 'trigger', 'shared')),
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flows_active_idx ON flows (trigger_kind) WHERE NOT paused;
CREATE INDEX IF NOT EXISTS flows_assistant_idx ON flows (assistant_id) WHERE assistant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed', 'stopped')),
  waits_for TEXT CHECK (waits_for IN ('go', 'answer', 'time', 'assignment')),
  label TEXT,
  assistant_id UUID REFERENCES team_assistants (id) ON DELETE SET NULL,
  summary TEXT,
  error TEXT,
  state TEXT NOT NULL,
  dry BOOLEAN NOT NULL DEFAULT false,
  resumes_at TIMESTAMPTZ,
  waiting_since TIMESTAMPTZ,
  plan_id UUID REFERENCES ask_plans (id) ON DELETE SET NULL,
  assignment_id UUID REFERENCES team_assignments (id) ON DELETE SET NULL,
  notices_pending BOOLEAN NOT NULL DEFAULT false,
  made TEXT[] NOT NULL DEFAULT '{}',
  event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  slot TEXT,
  started_by UUID,
  chain UUID[] NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flow_runs_flow_idx ON flow_runs (flow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS flow_runs_open_idx ON flow_runs (status) WHERE status IN ('queued', 'running', 'waiting');
CREATE INDEX IF NOT EXISTS flow_runs_resume_idx ON flow_runs (resumes_at) WHERE status = 'waiting' AND waits_for = 'time';
CREATE INDEX IF NOT EXISTS flow_runs_notices_idx ON flow_runs (id) WHERE notices_pending;
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_slot_idx ON flow_runs (flow_id, slot) WHERE slot IS NOT NULL;

-- What Ask did: a plain flow's changes are source 'flow', with the flow and the run they came from, so the log can
-- say "Flow: <name>" and open the run. Plain ids only; the flow's name stays sealed in flows.payload. No foreign
-- keys: a pruned run or a removed flow leaves the log's rows as they were.
ALTER TABLE ask_activity ADD COLUMN IF NOT EXISTS flow_id UUID;
ALTER TABLE ask_activity ADD COLUMN IF NOT EXISTS flow_run_id UUID;

-- Flows' triggers (0081, lib/flow-triggers.ts, lib/flow-triggers-db.ts). `team_events.flow_claimed_at`: flows mark
-- each event seen with their own column, beside Team's `processed_at`, so both see every event once.
-- `flow_trigger_fires`: one row per fire a flow has claimed (a schedule slot, one event's "before", one date's
-- "before", one flow's run for one event: `event:<id>`), so overlapping passes start it once. Plain: a flow's id, a
-- key of a kind, a record's id and a time; never a title. No foreign key: rows go after a week (FIRE_DAYS), and with
-- their flow when it's deleted (lib/flows.ts deleteFlow).
ALTER TABLE team_events ADD COLUMN IF NOT EXISTS flow_claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS team_events_flow_pending_idx ON team_events (id) WHERE flow_claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS flow_trigger_fires (
  flow_id TEXT NOT NULL,
  fire_key TEXT NOT NULL,
  fire_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, fire_key)
);
CREATE INDEX IF NOT EXISTS flow_trigger_fires_at_idx ON flow_trigger_fires (fire_at);

-- Flow suggestions (0082, lib/flow-suggest.ts): a suggestion the owner dismissed never comes back. `id` names the
-- kind of habit; one built on the owner's own words carries a short SHA-256 of them, never the words.
CREATE TABLE IF NOT EXISTS flow_suggestion_dismissals (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{3,80}$'),
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Assistants' triggers become flows (0083, lib/team-flows.ts). `flows.trigger_id`: the trigger a flow was made from
-- (one flow per trigger); `team_triggers.moved_at`: when it moved (a moved trigger never fires again);
-- `team_runs.flow_run_id`, `flow_id`: a run of an assistant's flow, kept as the assistant's run too.
ALTER TABLE flows ADD COLUMN IF NOT EXISTS trigger_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS flows_trigger_idx ON flows (trigger_id) WHERE trigger_id IS NOT NULL;
ALTER TABLE team_triggers ADD COLUMN IF NOT EXISTS moved_at TIMESTAMPTZ;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS flow_run_id UUID;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS flow_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS team_runs_flow_run_idx ON team_runs (flow_run_id) WHERE flow_run_id IS NOT NULL;
