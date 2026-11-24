-- Trackers made before 0085 have no record of who set their link. The owner chose (24 Nov 2026) to approve each of
-- those links once, so they're kept as the owner's and a run may open them as before (lib/run-links.ts, SECURITY.md
-- "Links a turn may open"). Only rows with no record are touched; anything set since keeps who set it. Safe to run
-- twice. Mirrored at db/schema.sql.
UPDATE trackers SET url_set_by = 'owner' WHERE url_set_by IS NULL AND url IS NOT NULL;
