-- Athena — the Plays and watches collection recipe.
--
-- A collection with no model: each run reads new plays, watches and likes
-- from music and film accounts straight into Days (Spotify, Last.fm,
-- ListenBrainz, Trakt, Plex, Jellyfin, YouTube, Letterboxd). See
-- netlify/lib/connectors/media-sync.ts.
--
-- Widens collections.recipe's CHECK to allow 'plays-watches'. Numbered after
-- 0063 (watch meta). Mirrored at db/schema.sql.

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_recipe_check;
ALTER TABLE collections ADD CONSTRAINT collections_recipe_check
  CHECK (recipe IN ('calendar-meetings', 'email-digest', 'work-activity', 'life-log', 'plays-watches', 'custom'));
