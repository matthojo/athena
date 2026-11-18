-- Athena — events Athena added to a calendar (lib/calendar-creates.ts,
-- SECURITY.md §9 "Adding and moving events"). Mirrored at db/schema.sql.
-- Safe to run twice.

-- One row per event Athena added, after the owner confirmed it. This list is
-- the only thing Undo may delete: an event that isn't here (or was already
-- undone) is never deleted. Ids only: no title, time or guests.
CREATE TABLE IF NOT EXISTS calendar_creates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  -- The provider's id for the event (iCloud: the id Athena's tools use for its file).
  event_id TEXT NOT NULL,
  -- "Open in calendar": the provider's link, when it gives one.
  url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Undo: deleted from the calendar, guests sent a cancellation.
  undone_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_creates_event_idx ON calendar_creates (connector_id, calendar_id, event_id);
