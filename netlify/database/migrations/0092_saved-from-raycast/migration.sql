-- Athena — Saved items from the Raycast extension (github.com/matthojo/athena-raycast) say so.
-- Additive only. Safe to run twice. Mirrored at db/schema.sql.
--
-- saved_items.source says how an item arrived. 0038 allowed 'shortcut', 'extension' (the browser extension),
-- 'share-target', 'app' and 'email'; this adds 'raycast'. Nothing already saved changes: a row keeps the source it
-- has. A copy that hasn't applied this yet files a 'raycast' save under 'app' (lib/saved.ts sourceOf), so the
-- extension works against it either way.
ALTER TABLE saved_items DROP CONSTRAINT IF EXISTS saved_items_source_check;
ALTER TABLE saved_items ADD CONSTRAINT saved_items_source_check
  CHECK (source IN ('shortcut', 'extension', 'share-target', 'app', 'email', 'raycast'));
