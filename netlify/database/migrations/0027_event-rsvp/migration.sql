-- Athena — answer invites: Going, Maybe or Declined on an event.
--
-- `rsvp` is your answer as Athena shows it. `rsvp_calendar` is the answer
-- the calendar last gave (null for an event that isn't an invite, or one you
-- added by hand). `rsvp_mine` means you chose `rsvp` yourself: it holds
-- until the calendar's own answer changes. `rsvp_error` says why the last
-- send to the calendar failed ('' when it didn't).
--
-- The calendar account, calendar and event id are what's needed to send the
-- answer back (lib/rsvp.ts). Ids only; nothing about the event itself.
--
-- Additive only. Numbered 0024 (0022 and 0023 are taken by other work).
-- Mirrored at db/schema.sql.

ALTER TABLE events ADD COLUMN rsvp TEXT NOT NULL DEFAULT 'none' CHECK (rsvp IN ('going', 'maybe', 'declined', 'none'));
ALTER TABLE events ADD COLUMN rsvp_calendar TEXT CHECK (rsvp_calendar IN ('going', 'maybe', 'declined', 'none'));
ALTER TABLE events ADD COLUMN rsvp_mine BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN rsvp_error TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN calendar_connector_id UUID REFERENCES connectors(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN calendar_id TEXT;
ALTER TABLE events ADD COLUMN calendar_event_id TEXT;
