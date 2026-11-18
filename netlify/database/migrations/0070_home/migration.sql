-- Athena — the Home collection recipe.
--
-- A collection with no model, run hourly: it reads the accounts whose figures
-- Athena keeps sealed (Octopus Energy, Monzo, Starling) and the appliances
-- (Home Connect). See netlify/lib/home/home-run.ts. Before this, the banks and
-- the meter were read only inside the evening Life log run.
--
-- 1. Widens collections.recipe's CHECK to allow 'home'.
-- 2. When there's no Home yet and any of those accounts is connected, makes
--    one with all of them, hourly and due now, so nothing stops being read: a
--    Life log leaves an account to an enabled Home, and the 15-minute
--    appliance look reads only the appliances a Home has. The accounts stay in
--    their Life log, which reads them again if Home is turned off.
--
-- Numbered after 0069 (team skills). Mirrored at db/schema.sql (the CHECK).

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_recipe_check;
ALTER TABLE collections ADD CONSTRAINT collections_recipe_check
  CHECK (recipe IN ('calendar-meetings', 'email-digest', 'work-activity', 'life-log', 'plays-watches', 'work-sync', 'home', 'custom'));

INSERT INTO collections (name, recipe, connector_ids, label, source, instructions, schedule, run_at, every_hours, lookback_hours, lookahead_days, event_push, enabled, next_run_at)
SELECT 'Home', 'home', ids, '', 'home', '', 'hourly', NULL, 1, 24, 0, false, true, now()
FROM (
  SELECT array_agg(id ORDER BY created_at) AS ids
  FROM connectors
  WHERE provider IN ('octopus', 'monzo', 'starling', 'home-connect')
) found
WHERE ids IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM collections WHERE recipe = 'home');
