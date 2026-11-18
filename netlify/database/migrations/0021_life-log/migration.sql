-- Athena — the Life log collection recipe.
--
-- A built-in collection for what you watch, play, listen to, read and post
-- (Trakt, YouTube, Reddit, Spotify, Last.fm, Letterboxd, Goodreads, Steam):
-- a day-by-day log plus daily counts. See netlify/lib/connectors/recipes.ts.
--
-- Widens collections.recipe's CHECK to allow 'life-log'. Numbered after 0020
-- (owner edits). Mirrored at db/schema.sql.

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_recipe_check;
ALTER TABLE collections ADD CONSTRAINT collections_recipe_check
  CHECK (recipe IN ('calendar-meetings', 'email-digest', 'work-activity', 'life-log', 'custom'));
