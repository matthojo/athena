-- Athena — each collection run links to exactly what it saved.
--
-- `collected_items.run_id`: the run that last saved the item (runner.ts sets
-- it). GET /api/collections/:id/runs/:run/items lists by it for runs made
-- from now on (settings `run_items_exact_since`, set here), and by the run's
-- time window for older runs (lib/connectors.ts listRunItems). Imports
-- (YouTube, Goodreads) leave it null.
--
-- Nullable, no foreign key: an id whose run has gone matches nothing, which is
-- what the items list wants anyway. Additive only. Numbered after 0021
-- (0022 is another branch's). Mirrored at db/schema.sql.

ALTER TABLE collected_items ADD COLUMN run_id UUID;
CREATE INDEX collected_items_run_idx ON collected_items (run_id) WHERE run_id IS NOT NULL;
INSERT INTO settings (key, value) VALUES ('run_items_exact_since', to_jsonb(now())) ON CONFLICT (key) DO NOTHING;
