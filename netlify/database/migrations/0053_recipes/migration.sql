-- Athena — Recipes: recipes read from their pages, the cooked log, the week's
-- dinners and the grocery list (docs/notes/recipes.md, SECURITY.md §11 and
-- "Recipes: reading recipe pages"). Mirrored at db/schema.sql. Safe to run twice.

-- A recipe. The owner's words and the page's (title, address, the body with
-- ingredients, steps and notes as one JSON value, tags) are sealed under the
-- data key. Readable: minutes and servings (filters and the week plan), how
-- it was read, dates. url_bidx is a blind index of the page's canonical
-- address, so the same recipe imported twice is one. saved_id points at the
-- Saved item it came from: its page, readable copy and photo stay there.
CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_id UUID REFERENCES saved_items(id) ON DELETE SET NULL,
  url TEXT,
  url_bidx TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  total_minutes INT,
  servings INT,
  parse TEXT NOT NULL DEFAULT 'manual' CHECK (parse IN ('json-ld', 'microdata', 'model', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_url_idx ON recipes (url_bidx) WHERE url_bidx IS NOT NULL AND archived_at IS NULL;
-- One recipe per Saved item, archived or not: moving Saved's recipe links in runs once per item.
CREATE UNIQUE INDEX IF NOT EXISTS recipes_saved_idx ON recipes (saved_id) WHERE saved_id IS NOT NULL;

-- "Mark as cooked": one row per recipe and day.
CREATE TABLE IF NOT EXISTS recipe_cooked (
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, cooked_on)
);
CREATE INDEX IF NOT EXISTS recipe_cooked_on_idx ON recipe_cooked (cooked_on DESC);

-- The week's dinners: one row per evening the owner kept a plan for.
CREATE TABLE IF NOT EXISTS meal_plan (
  day DATE PRIMARY KEY,
  recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL,
  servings INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The grocery list: one list, kept in Athena. What to buy is sealed; the
-- amount, unit and aisle are readable (they name nothing without the item).
CREATE TABLE IF NOT EXISTS grocery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item TEXT NOT NULL,
  quantity NUMERIC,
  unit TEXT,
  aisle TEXT NOT NULL DEFAULT 'other',
  recipe_ids UUID[] NOT NULL DEFAULT '{}',
  own BOOLEAN NOT NULL DEFAULT false,
  ticked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_items_created_idx ON grocery_items (created_at);
