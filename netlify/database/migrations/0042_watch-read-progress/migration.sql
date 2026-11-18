-- Athena — how far through a Watch & read item you are (lib/watch-read.ts
-- progress rules, lib/memory.ts upsertReadingItem; docs/notes/rich-links-stage2s.md).
--
-- One of three shapes, in `progress_unit`:
--   'page'    — pages read, out of a total if you know it    (a book, a paper)
--   'episode' — episodes seen or heard, out of a total if known (a TV show, a podcast)
--   'percent' — 0 to 100, no total                           (anything; an ebook's own %)
-- No unit means no position is kept: the status alone says where you are.
--
-- Plain numbers, like goals.progress: they say nothing without the title,
-- which stays sealed. Additive only, so every existing row has no progress.
-- Numbered after main's 0041. Mirrored at db/schema.sql.

ALTER TABLE reading_items ADD COLUMN IF NOT EXISTS progress_unit TEXT;
ALTER TABLE reading_items ADD COLUMN IF NOT EXISTS progress_done INT;
ALTER TABLE reading_items ADD COLUMN IF NOT EXISTS progress_total INT;

ALTER TABLE reading_items DROP CONSTRAINT IF EXISTS reading_items_progress_check;
ALTER TABLE reading_items ADD CONSTRAINT reading_items_progress_check CHECK (
  -- A CASE, so a NULL can't make the check pass by default.
  CASE
    WHEN progress_unit IS NULL THEN progress_done IS NULL AND progress_total IS NULL
    WHEN progress_unit = 'percent' THEN progress_done IS NOT NULL AND progress_done BETWEEN 0 AND 100 AND progress_total IS NULL
    WHEN progress_unit IN ('page', 'episode') THEN progress_done IS NOT NULL AND progress_done >= 0
      AND (progress_total IS NULL OR (progress_total >= 1 AND progress_done <= progress_total))
    ELSE false
  END
);
