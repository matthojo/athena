-- Athena — Days: one record per calendar day, with structured entries
-- (lib/days.ts, lib/day-types.ts; SECURITY.md §1 "Days" and §11).
--
-- Days replace the Life log's day notes (owner decision, 7 Nov 2026). Every
-- source writes entries for a day (a Life log run through athena_day_entry,
-- the Netflix, Goodreads and YouTube imports); the run writes the day's one
-- line (athena_day_line), which the owner can edit. The owner adds a mood,
-- a journal entry and photos. Health and places stay in sensitive_blobs and
-- the API joins them; notes and events are linked by date when read.
--
-- days: the line is sealed like note text (§11). Mood and journal are one
-- JSON value sealed under the data key, like a health day: the check
-- refuses anything readable, so a deploy without the key can't store them.
--
-- day_entries: one row per thing that happened. Kind, source, date, time,
-- rating, count and minutes stay readable (lists, counts and the calendar
-- heat use them); the title, subtitle, link, group, note and the source's
-- own id are sealed. A source's id is matched by blind index (ext_key), so
-- saving the same item again updates it: "deduped by source and external
-- id". folded_into points a second source's copy (Trakt's line for a
-- Netflix episode) at the entry it was folded into; reads skip it.
-- art is the cover's id, size and tone (lib/day-types.ts DayArt): no title,
-- no address.
--
-- day_files: the day's photos, files like a note's (lib/files.ts keeps a
-- file while a day uses it).
--
-- Mirrored at db/schema.sql.

CREATE TABLE IF NOT EXISTS days (
  date DATE PRIMARY KEY,
  line TEXT,
  line_by TEXT CHECK (line_by IN ('run', 'owner')),
  line_run UUID,
  private TEXT CHECK (private IS NULL OR private LIKE 'enc:v1:%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS days_updated_idx ON days (updated_at);

CREATE TABLE IF NOT EXISTS day_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('watched', 'listened', 'read', 'highlight', 'played', 'posted', 'saved', 'chess', 'workout', 'other')),
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
  count INT NOT NULL DEFAULT 1 CHECK (count >= 1),
  minutes INT CHECK (minutes IS NULL OR minutes >= 0),
  art JSONB,
  position INT NOT NULL DEFAULT 0,
  folded_into UUID REFERENCES day_entries(id) ON DELETE SET NULL,
  collection TEXT,
  run_id UUID,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS day_entries_key_idx ON day_entries (source, ext_key);
CREATE INDEX IF NOT EXISTS day_entries_date_idx ON day_entries (date);
CREATE INDEX IF NOT EXISTS day_entries_run_idx ON day_entries (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS day_files (
  date DATE NOT NULL,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, file_id)
);
CREATE INDEX IF NOT EXISTS day_files_file_idx ON day_files (file_id);
