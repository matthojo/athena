-- Athena — collections keep what they wrote in step with the source.
--
--  1. collected_items maps a source item to any kind of record it became (a
--     note, or an event synced from a calendar), keeps the item's date and
--     title so a run can list what it holds for a window, and survives the
--     record being archived or deleted: that's how a collection remembers
--     you dismissed something and doesn't write it again. No foreign key, so
--     a permanently deleted record leaves its mapping behind on purpose.
--  2. events gain `source` (which collection synced them) and `timed_push`
--     (whether to push 30 minutes before; synced meetings default to off).
--  3. collections gain `lookahead_days` (sync upcoming calendar events into
--     Athena's events, 0 = off) and `event_push` (push before those events).
-- Additive apart from collected_items, which only ever held collector data.
-- Mirrored for reference at db/schema.sql.

ALTER TABLE collected_items DROP CONSTRAINT collected_items_note_id_fkey;
ALTER TABLE collected_items RENAME COLUMN note_id TO record_id;
ALTER TABLE collected_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'event'));
-- true = the collector archived it because the source item was cancelled or
-- deleted (so it may restore it if the item comes back); false = you did.
ALTER TABLE collected_items ADD COLUMN archived_by_collector BOOLEAN NOT NULL DEFAULT false;
-- The source item's Europe/London date (an event's day, a meeting's day).
ALTER TABLE collected_items ADD COLUMN item_date DATE;
ALTER TABLE collected_items ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE collected_items DROP CONSTRAINT collected_items_pkey;
ALTER TABLE collected_items ADD PRIMARY KEY (source, kind, external_id);
CREATE INDEX collected_items_window_idx ON collected_items (source, kind, item_date);

ALTER TABLE events ADD COLUMN source TEXT;
ALTER TABLE events ADD COLUMN timed_push BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE collections ADD COLUMN lookahead_days INT NOT NULL DEFAULT 0 CHECK (lookahead_days BETWEEN 0 AND 60);
ALTER TABLE collections ADD COLUMN event_push BOOLEAN NOT NULL DEFAULT false;
