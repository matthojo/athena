-- Athena — a skipped habit is a Day entry with count 0 (lib/day-imports.ts,
-- docs/notes/connectors-research-2.md: "count = done (1/0)").
--
-- Imports from Loop, Daylio and Bearable write one entry per habit a day:
-- done (count 1) or skipped (count 0, note "skipped"). A count of 0 adds
-- nothing to the day's totals or heat. Every other entry still writes 1 or
-- more. Idempotent, so it composes with any other batch relaxing the same
-- check. Mirrored at db/schema.sql.
ALTER TABLE day_entries DROP CONSTRAINT IF EXISTS day_entries_count_check;
ALTER TABLE day_entries ADD CONSTRAINT day_entries_count_check CHECK (count >= 0);
