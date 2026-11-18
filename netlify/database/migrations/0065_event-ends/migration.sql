-- Athena — when a timed event ends.
--
-- events.ends_at: the UTC instant a timed one-off ends, as the calendar gives
-- it. Calendar sync (athena_save_event) stores it; events saved before this
-- gain it on their next sync. NULL for all-day and yearly events, and for any
-- event whose end Athena doesn't know (the Day ribbon then draws 45 minutes).
-- Numbered after 0064 (plays and watches). Mirrored at db/schema.sql.

ALTER TABLE events ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
