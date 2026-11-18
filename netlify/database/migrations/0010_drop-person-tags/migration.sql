-- Athena — a person linked to a note doesn't also need to be one of its tags.
-- Meeting collections tagged notes with attendee names as well as linking the
-- people. This drops those tags: a linked (live) person's full name, first
-- name or email, ignoring case and a leading # or @. Topic tags stay, and so
-- do the links. lib/db.ts dropLinkedPeopleTags keeps it this way from now on.
-- Data only; no schema change.

WITH linked AS (
  SELECT e.source_id AS note_id, p.name, p.email
  FROM edges e JOIN people p ON p.id = e.target_id
  WHERE e.source_type = 'note' AND e.target_type = 'person' AND p.archived_at IS NULL
  UNION ALL
  SELECT e.target_id, p.name, p.email
  FROM edges e JOIN people p ON p.id = e.source_id
  WHERE e.target_type = 'note' AND e.source_type = 'person' AND p.archived_at IS NULL
),
names AS (
  SELECT note_id, lower(btrim(name)) AS key FROM linked
  UNION SELECT note_id, lower(split_part(btrim(name), ' ', 1)) FROM linked
  UNION SELECT note_id, lower(btrim(email)) FROM linked WHERE coalesce(email, '') <> ''
)
UPDATE notes nt
SET tags = ARRAY(
  SELECT t FROM unnest(nt.tags) WITH ORDINALITY AS u(t, i)
  WHERE lower(regexp_replace(btrim(t), '^[#@]+', '')) NOT IN (SELECT key FROM names WHERE names.note_id = nt.id)
  ORDER BY i
)
WHERE EXISTS (
  SELECT 1 FROM unnest(nt.tags) AS t
  JOIN names ON names.note_id = nt.id AND names.key = lower(regexp_replace(btrim(t), '^[#@]+', ''))
);
