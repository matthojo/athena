-- Athena — history loaded when an account is connected (netlify/lib/connectors/backfill.ts,
-- docs/notes/backfill.md).
--
-- A backfill reads an account's whole history straight from its API and
-- writes it as Day entries and Watch & read items, like an import. Rows it
-- made carry `backfilled = true`: they belong in history and in the taste
-- profile, never in "what's new" (a run's saved items, today's counts).
-- A row a collection run or the owner saved first stays false.
--
-- Progress per account is in `settings` (key `history_load.<connector id>`), so
-- nothing else changes. Additive only. Numbered after main's 0048.
-- Mirrored at db/schema.sql.

ALTER TABLE day_entries ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reading_items ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT false;
