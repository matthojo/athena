-- Athena — to-do contexts (lib/todo-context.ts has the rules, lib/todo-contexts.ts
-- the reads and writes; SECURITY.md §11). Mirrored at db/schema.sql.
--
-- A to-do can carry one area (which part of life: Work, Health…) and one
-- where/how (Phone, Errands…), each optional. The owner edits the list in
-- Settings → To do. `key` marks a starter context ("work", "phone") so the
-- rules still find it after a rename; the owner's own have none.
--
-- Removing a context archives it: to-dos keep the id but read it as blank, so
-- Undo brings every to-do's context back. Names, icons and colours are
-- readable (labels, like fact keys); to-do titles stay sealed.
--
-- commitments.context_by_athena: Athena set the context itself (a collection,
-- an agent, Ask), so the app marks it and one tap changes it. The owner
-- picking a context clears it.
--
-- todo_context_hints: the owner's last correction for a sender or source
-- ('person:<uuid>' or 'source:<source>'), which the next to-do from there follows.

CREATE TABLE IF NOT EXISTS todo_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('area', 'where')),
  key TEXT CHECK (key IS NULL OR key ~ '^[a-z_]{1,30}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  icon TEXT NOT NULL DEFAULT 'tag' CHECK (icon ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  colour TEXT NOT NULL DEFAULT 'grey' CHECK (colour IN ('grey', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'violet')),
  position INT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS todo_contexts_key_idx ON todo_contexts (kind, key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS todo_contexts_name_idx ON todo_contexts (kind, lower(name)) WHERE archived_at IS NULL;

INSERT INTO todo_contexts (kind, key, name, icon, colour, position) VALUES
  ('area', 'work', 'Work', 'briefcase', 'blue', 0),
  ('area', 'personal', 'Personal', 'person', 'violet', 1),
  ('area', 'health', 'Health', 'heart', 'red', 2),
  ('area', 'money', 'Money', 'wallet', 'green', 3),
  ('area', 'family', 'Family', 'people', 'amber', 4),
  ('area', 'home', 'Home', 'home', 'teal', 5),
  ('where', 'computer', 'Computer', 'laptop', 'blue', 0),
  ('where', 'phone', 'Phone', 'phone', 'green', 1),
  ('where', 'errands', 'Errands', 'bag', 'amber', 2),
  ('where', 'home', 'Home', 'home', 'teal', 3),
  ('where', 'office', 'Office', 'building', 'grey', 4),
  ('where', 'with_someone', 'With someone', 'chat', 'pink', 5),
  ('where', 'anywhere', 'Anywhere', 'globe', 'grey', 6)
ON CONFLICT DO NOTHING;

ALTER TABLE commitments
  ADD COLUMN IF NOT EXISTS area_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS where_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS context_by_athena BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS commitments_area_idx ON commitments (area_id) WHERE area_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commitments_where_idx ON commitments (where_id) WHERE where_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS todo_context_hints (
  key TEXT PRIMARY KEY CHECK (key ~ '^(person|source):.{1,200}$'),
  area_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  where_id UUID REFERENCES todo_contexts(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
