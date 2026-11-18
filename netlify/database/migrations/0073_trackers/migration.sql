-- Tracking (lib/trackers.ts, lib/trackers-store.ts; contract lib/tracker-types.ts; docs/team.md "Tracking").
-- Owner, 16 Nov 2026: track anything over time, a number with a label and a prefix or suffix ("£34", "12,400
-- followers") or a state ("in stock"), on a saved item or on its own, several per thing. A price is a preset
-- (label "price", a currency, lower is better), and so is stock. Numbered 0073: a sibling takes 0072. This
-- replaced 0073_saved-prices before it shipped anywhere, so there is nothing to carry over.
--
-- Sealed (lib/encryption.ts): a tracker's name, link, label, prefix, suffix, states and target value; a check's
-- value, source and link. Readable: kinds, directions, presets, the currency code, times and who checked.
-- `removed_at` is Undo: a tracker or a check is hidden, never deleted. Rows go with their saved item (cascade).
-- The save-time price is kept by lib/trackers-store.ts, not here: a migration never sees the key that opens
-- `saved_items.facts`.
CREATE TABLE IF NOT EXISTS trackers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The saved item it follows, or null for one on its own.
  saved_id UUID REFERENCES saved_items(id) ON DELETE CASCADE,
  -- On its own: what's followed. On a saved item: empty, the item's name is used.
  name TEXT NOT NULL DEFAULT '',
  url TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('number', 'state')),
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  currency TEXT CHECK (currency ~ '^[A-Z]{3}$'),
  states TEXT[] NOT NULL DEFAULT '{}',
  direction TEXT NOT NULL CHECK (direction IN ('lower', 'higher', 'change')),
  preset TEXT CHECK (preset IN ('price', 'stock')),
  -- "Tell me when": one per tracker.
  target_op TEXT CHECK (target_op IN ('lte', 'gte', 'eq', 'change')),
  target_value TEXT,
  target_set_by TEXT CHECK (target_set_by IN ('owner', 'ask', 'assistant')),
  target_assistant_id UUID,
  target_set_at TIMESTAMPTZ,
  -- The Team assistant that checks it. No foreign key: the history outlives the assistant.
  assistant_id UUID,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'state' OR states = '{}'),
  CHECK (preset IS DISTINCT FROM 'price' OR currency IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trackers_item_idx ON trackers (saved_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS trackers_assistant_idx ON trackers (assistant_id) WHERE removed_at IS NULL AND assistant_id IS NOT NULL;
-- One price and one stock tracker per saved item, so the save and the back-fill can run any number of times.
CREATE UNIQUE INDEX IF NOT EXISTS trackers_item_preset_idx ON trackers (saved_id, preset) WHERE saved_id IS NOT NULL AND preset IS NOT NULL AND removed_at IS NULL;

-- One row per check, kept forever (owner, 16 Nov 2026), unchanged values too.
CREATE TABLE IF NOT EXISTS tracker_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id UUID NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  source TEXT,
  url TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_by TEXT NOT NULL CHECK (checked_by IN ('save', 'owner', 'ask', 'assistant')),
  assistant_id UUID,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Anything Ask or an assistant keeps comes with the page it was read on; the owner may add one by hand without.
  CHECK (checked_by IN ('owner', 'save') OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tracker_points_idx ON tracker_points (tracker_id, checked_at) WHERE removed_at IS NULL;
-- At most one save-time check per tracker.
CREATE UNIQUE INDEX IF NOT EXISTS tracker_points_save_idx ON tracker_points (tracker_id) WHERE checked_by = 'save';
