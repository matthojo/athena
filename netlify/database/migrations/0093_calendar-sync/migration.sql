-- Athena — the Calendar collection recipe.
--
-- A collection with no model, run hourly: it keeps Athena's events in step
-- with the next N days of the owner's calendars (Google, Outlook, iCloud).
-- See netlify/lib/connectors/calendar-sync.ts. Before this, a Meetings
-- collection with upcoming-event sync had Claude list and save every event
-- on every run.
--
-- 1. Widens collections.recipe's CHECK to allow 'calendar-sync'.
-- 2. For each Meetings collection that syncs upcoming events and reads a
--    calendar account, makes a Calendar with those calendar accounts, the
--    same look-ahead and reminder setting, on or off as the Meetings
--    collection is, hourly and due now. While a Calendar reads all of a
--    Meetings collection's calendars, that collection leaves the events to
--    it (runner.ts); its own lookahead_days is left as it was, so turning
--    Calendar off or deleting it hands the events back.
--
-- Numbered after 0092 (saved source open). Mirrored at db/schema.sql (the CHECK).

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_recipe_check;
ALTER TABLE collections ADD CONSTRAINT collections_recipe_check
  CHECK (recipe IN ('calendar-meetings', 'calendar-sync', 'email-digest', 'work-activity', 'life-log', 'plays-watches', 'work-sync', 'home', 'custom'));

INSERT INTO collections (name, recipe, connector_ids, label, source, instructions, schedule, run_at, every_hours, lookback_hours, lookahead_days, event_push, enabled, next_run_at)
SELECT DISTINCT ON (found.source)
  CASE WHEN found.label = '' THEN 'Calendar' ELSE 'Calendar · ' || found.label END,
  'calendar-sync', found.ids, found.label, found.source, '', 'hourly', NULL, 1, 24,
  found.lookahead_days, found.event_push, found.enabled,
  CASE WHEN found.enabled THEN now() ELSE NULL END
FROM (
  SELECT m.created_at, m.label, m.lookahead_days, m.event_push, m.enabled,
         -- 'calendar-meetings-work' → 'calendar-sync-work'
         CASE WHEN m.source LIKE 'calendar-meetings%' THEN 'calendar-sync' || substring(m.source FROM 18) ELSE left('calendar-sync-' || m.source, 61) END AS source,
         ARRAY(
           SELECT u.id FROM unnest(m.connector_ids) WITH ORDINALITY AS u(id, n)
           JOIN connectors c ON c.id = u.id
           WHERE c.provider IN ('google-calendar', 'outlook-calendar', 'icloud-calendar')
           ORDER BY u.n
         ) AS ids
  FROM collections m
  WHERE m.recipe = 'calendar-meetings' AND m.lookahead_days > 0
) found
WHERE cardinality(found.ids) > 0
  AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.source = found.source)
ORDER BY found.source, found.created_at;
