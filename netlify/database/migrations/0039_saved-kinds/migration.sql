-- Athena — Saved actions (lib/saved-kinds.ts, lib/saved-actions.ts; docs/notes/saved-actions.md).
-- Mirrored at db/schema.sql.
--
-- thing: what a saved item is, read at save time from the page's schema.org,
-- Open Graph or a known site (book, film, show, product, recipe, place,
-- event, article, video, image). Readable, like kind, for the card's line
-- and for which actions fit. facts: what's known about it (author, ISBN,
-- price, address…) as JSON, sealed like the title (ENCRYPTED in
-- lib/encryption.ts).
--
-- filed_at / filed_to: an item moved somewhere by an action ("Move to Watch &
-- read", "Gift idea for Sophie") leaves the main list and shows under Filed.
-- filed_to is sealed JSON: the action, where it went (label and app link) and
-- how to undo it on the other side.
--
-- edges may now start at a saved item ("Link to a person, note or project").

ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS thing TEXT
  CHECK (thing IS NULL OR thing IN ('book', 'film', 'show', 'product', 'recipe', 'place', 'event', 'article', 'video', 'image'));
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS facts TEXT;
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS filed_at TIMESTAMPTZ;
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS filed_to TEXT;
CREATE INDEX IF NOT EXISTS saved_items_filed_idx ON saved_items (filed_at DESC) WHERE filed_at IS NOT NULL;

ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_source_type_check;
ALTER TABLE edges ADD CONSTRAINT edges_source_type_check
  CHECK (source_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record', 'saved'));
ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_target_type_check;
ALTER TABLE edges ADD CONSTRAINT edges_target_type_check
  CHECK (target_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record', 'saved'));
