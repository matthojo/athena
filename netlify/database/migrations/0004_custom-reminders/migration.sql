-- Athena — custom reminders: "remind me to call the plumber at 17:00".
-- Free-text reminders at a chosen instant, optionally repeating and optionally
-- about something in Athena (a person, note, event, …). Delivered by
-- netlify/functions/reminders.ts as a push, and listed in that day's briefing.
-- Additive only, like 0002/0003. Mirrored for reference at db/schema.sql.
CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL CHECK (length(btrim(text)) > 0),
  remind_at TIMESTAMPTZ NOT NULL,           -- when it next fires
  repeat TEXT NOT NULL DEFAULT 'none'
    CHECK (repeat IN ('none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly')),
  -- Day of month it was set for (Europe/London), so monthly/yearly repeats on
  -- the 31st come back to the 31st after a short month.
  anchor_day SMALLINT NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
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
