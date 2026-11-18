-- Athena — "full PA": places, organisations, dated events, archive, push reminders.
-- Additive only: no existing column is dropped or retyped, so the live app
-- keeps working against this schema before and after the new code ships.
-- Mirrored for reference at db/schema.sql — keep that file in sync.

-- ---------- Archive (soft hide) ----------
-- Archived rows stay in the database but every read path filters
-- `archived_at IS NULL`, except the app's Archived page. Permanent delete is
-- a manual, app-only action (see SECURITY.md §"Archive vs delete").
ALTER TABLE notes ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE people ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX notes_live_updated_idx ON notes (updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX notes_archived_idx ON notes (archived_at DESC) WHERE archived_at IS NOT NULL;
CREATE INDEX people_live_name_idx ON people (name) WHERE archived_at IS NULL;
CREATE INDEX people_archived_idx ON people (archived_at DESC) WHERE archived_at IS NOT NULL;
CREATE INDEX projects_archived_idx ON projects (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- People: richer CRM fields ----------
-- Birthdays are NOT a column here: they live in `events` (kind 'birthday',
-- person_id set) so Coming up, reminders and the briefing read one table.
ALTER TABLE people ADD COLUMN relationship TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN catch_up_days INT CHECK (catch_up_days IS NULL OR catch_up_days > 0); -- null = default (60)

-- ---------- Places ----------
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

-- ---------- Organisations ----------
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

-- ---------- Events & dates ----------
-- `date` + optional `time` are Europe/London local (no time zone on purpose:
-- "my mum's birthday is 4 March" is a local calendar fact, not an instant).
-- For yearly events whose year isn't known (year_known = false) `date` carries
-- the placeholder year 2000, a leap year, so 29 February is representable.
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
  -- Set for a person's birthday: the person profile's birthday field is a
  -- shortcut that creates/updates this row. One birthday per person.
  person_id UUID REFERENCES people(id) ON DELETE CASCADE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_live_date_idx ON events (date) WHERE archived_at IS NULL;
CREATE INDEX events_archived_idx ON events (archived_at DESC) WHERE archived_at IS NOT NULL;
CREATE UNIQUE INDEX events_person_birthday_idx ON events (person_id) WHERE kind = 'birthday' AND person_id IS NOT NULL;

-- ---------- Graph: more entity kinds + where a link came from ----------
-- The CHECKs in 0001 were declared inline, so Postgres named them
-- <table>_<column>_check.
ALTER TABLE edges DROP CONSTRAINT edges_source_type_check;
ALTER TABLE edges DROP CONSTRAINT edges_target_type_check;
ALTER TABLE edges ADD CONSTRAINT edges_source_type_check
  CHECK (source_type IN ('note', 'person', 'project', 'place', 'organisation', 'event'));
ALTER TABLE edges ADD CONSTRAINT edges_target_type_check
  CHECK (target_type IN ('note', 'person', 'project', 'place', 'organisation', 'event'));
-- 'content' = derived from athena:// links in a note body, re-synced on every
-- note save; 'manual' = created explicitly (MCP `link`, the app) and never
-- touched by that sync.
ALTER TABLE edges ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'content'));

-- ---------- Push reminders ----------
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency for the scheduled reminders function: a key like
-- 'briefing:2026-11-05' or 'event:<id>:2026-11-05T14:00' is inserted before a
-- send, so overlapping or retried runs never notify twice.
CREATE TABLE reminder_log (
  key TEXT PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
