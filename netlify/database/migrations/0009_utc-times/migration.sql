-- Athena — instants in UTC, shown in whatever time zone is looking.
--
--  1. events.starts_at: the UTC instant a timed one-off event starts. Until
--     now a timed event was a Europe/London date + time; those are converted
--     here (and their `time` cleared, so there's one source of truth). Dates
--     without a time (birthdays, all-day, deadlines) stay plain dates, and a
--     yearly event can keep a wall-clock `time` (19:00 wherever you are).
--  2. settings: small owner preferences. `timezone` is the IANA zone the
--     owner's device last reported; the server uses it for "today", the
--     07:30 briefing and collections' "daily at" times, so they follow you
--     when you travel. Until a device reports one, Europe/London.
-- Mirrored for reference at db/schema.sql.

ALTER TABLE events ADD COLUMN starts_at TIMESTAMPTZ;

UPDATE events
SET starts_at = (date + time) AT TIME ZONE 'Europe/London', time = NULL
WHERE time IS NOT NULL AND recurrence = 'none';

ALTER TABLE events ADD CONSTRAINT events_starts_at_one_off CHECK (starts_at IS NULL OR recurrence = 'none');
CREATE INDEX events_live_starts_idx ON events (starts_at) WHERE archived_at IS NULL AND starts_at IS NOT NULL;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
