-- Athena — @-mentions of to-dos and Watch & read titles become graph edges
-- (docs/notes/mention-edges.md). Mirrored at db/schema.sql.
--
-- A note's [@Book the dentist](athena://todo/<id>) and
-- [@The Bear](athena://watch/<id>) links are stored in edges like any other
-- mention, under their tables' names: 'commitment' and 'reading' (lib/links.ts
-- EDGE_KIND). 'saved' came in 0039. Existing notes are synced by the
-- backfill-content-links scheduled function, since note bodies are sealed.
-- Safe to run twice.

ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_source_type_check;
ALTER TABLE edges ADD CONSTRAINT edges_source_type_check
  CHECK (source_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record', 'saved', 'commitment', 'reading'));
ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_target_type_check;
ALTER TABLE edges ADD CONSTRAINT edges_target_type_check
  CHECK (target_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record', 'saved', 'commitment', 'reading'));
