-- Athena — which calendars a Google Calendar or Outlook account reads.
--
-- `calendars` holds the ids switched on. NULL means the owner hasn't chosen
-- yet, so only the main calendar is read; calendars found later stay off.
-- Ids only, nothing secret. iCloud keeps its choice in `scope`, as built.
--
-- Additive only. Mirrored at db/schema.sql.

ALTER TABLE connectors ADD COLUMN calendars TEXT[];
