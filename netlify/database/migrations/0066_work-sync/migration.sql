-- Athena — Your work, counted: the work sync recipe and its store.
--
-- A collection with no model, like Plays and watches (0064): each run reads
-- the owner's own Linear issues and GitHub pull requests straight into
-- work_items. See netlify/lib/connectors/work-sync.ts and lib/work.ts.
--
-- 1. Widens collections.recipe's CHECK to allow 'work-sync'.
-- 2. work_items: one row per issue or PR, keyed by its source and a hash of
--    its id. Everything about it is one sealed value; nothing readable but
--    the source, the hash and whether it's an issue or a PR.
--
-- Numbered after 0065 (event ends). Mirrored at db/schema.sql.

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_recipe_check;
ALTER TABLE collections ADD CONSTRAINT collections_recipe_check
  CHECK (recipe IN ('calendar-meetings', 'email-digest', 'work-activity', 'life-log', 'plays-watches', 'work-sync', 'custom'));

CREATE TABLE IF NOT EXISTS work_items (
  source TEXT NOT NULL CHECK (source IN ('linear', 'github')),
  item_key TEXT NOT NULL CHECK (item_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, item_key)
);
