-- Athena — a saved item's source is a short name any client can give, not one of a fixed list.
-- Safe to run twice. Mirrored at db/schema.sql.
--
-- saved_items.source says how an item arrived. 0038 allowed five values ('shortcut', 'extension', 'share-target',
-- 'app', 'email'), so a new way in (the Raycast extension, github.com/matthojo/athena-raycast, which sends 'raycast')
-- needed a migration before it could say what it was. From here the column takes any short lower-case name: a
-- letter, then letters, digits or hyphens, 40 characters at most. lib/saved-rules.ts cleanSource holds the same
-- rule, and files anything else under 'app'.
--
-- Nothing already saved changes: all five old values fit the new rule. A copy that hasn't applied this yet files a
-- name it doesn't know under 'app' (the old sourceOf), so a newer client works against it either way.
ALTER TABLE saved_items DROP CONSTRAINT IF EXISTS saved_items_source_check;
ALTER TABLE saved_items ADD CONSTRAINT saved_items_source_check
  CHECK (source ~ '^[a-z][a-z0-9-]{0,39}$');
