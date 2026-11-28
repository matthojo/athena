-- Athena — what the grocery list remembers: each shop, what was bought on
-- it, and the usuals the owner said "not this time" to (lib/grocery-memory.ts).
--
-- "Done shopping" files the ticked lines as one shop instead of deleting
-- them. From those shops the list works out the owner's usuals (things bought
-- every so often, offered again when they're due) and the order they walk
-- their shop in (aisles, in the order they were ticked).
--
-- Sealed under the data key: what was bought, and what a skip is for.
-- Readable: dates, amounts, units, aisle ids and counts, which name nothing
-- without the item. Additive only. Mirrored at db/schema.sql.

-- One shop. aisle_order: the aisle ids in the order their first line was
-- ticked, kept only when the ticks were spread out like a walk round a shop
-- (empty when everything was ticked at once).
CREATE TABLE IF NOT EXISTS grocery_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  done_at TIMESTAMPTZ NOT NULL,
  item_count INT NOT NULL DEFAULT 0,
  aisle_order TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_trips_done_idx ON grocery_trips (done_at DESC);

-- What was bought on a shop: one row per ticked line, with the recipes it
-- was for, whether the owner added it and when it was ticked, so "Undo" can
-- put the line back as it was.
CREATE TABLE IF NOT EXISTS grocery_bought (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES grocery_trips(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  quantity NUMERIC,
  unit TEXT,
  aisle TEXT NOT NULL DEFAULT 'other',
  recipe_ids UUID[] NOT NULL DEFAULT '{}',
  own BOOLEAN NOT NULL DEFAULT false,
  ticked_at TIMESTAMPTZ,
  bought_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_bought_at_idx ON grocery_bought (bought_at DESC);

-- A usual the owner skipped: not offered again until `until`.
CREATE TABLE IF NOT EXISTS grocery_skips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item TEXT NOT NULL,
  until DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_skips_until_idx ON grocery_skips (until);
