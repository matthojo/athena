-- Who set a tracker's link (lib/trackers-store.ts, lib/run-links.ts). A run may open a tracker's link only when the
-- owner supplied or approved it. Additive only. Safe to run twice. Mirrored at db/schema.sql.
--
-- 'owner': the owner typed it, or gave their Go to it. 'item': the saved item's own link, copied when the tracker was
-- made. 'ask' / 'assistant': a model chose it and the owner hasn't approved it, so no run opens it.
-- NULL: made before this column. A saved item's tracker whose link is still the item's own counts as the item's;
-- any other link isn't opened until the owner saves it again.
ALTER TABLE trackers ADD COLUMN IF NOT EXISTS url_set_by TEXT CHECK (url_set_by IN ('owner', 'item', 'ask', 'assistant'));
