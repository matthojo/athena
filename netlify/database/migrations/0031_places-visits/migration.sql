-- Athena — where you went each day, sealed (lib/places-visits.ts, SECURITY.md §1 "Places and visits").
--
-- Visits live in sensitive_blobs like health days: one row per (domain
-- 'location', source, day), JSON sealed under the data key. Sources:
-- 'timeline' (a Google Maps Timeline import), 'swarm' (check-ins) and 'day'
-- (the two merged, with names and the Life log line). The label is the day
-- and the source, never a place. The existing check keeps every day row sealed.
--
-- place_geo: a Place's coordinates, Google and Foursquare ids, town, and the
-- days it was visited, sealed as one JSON value. location_cache: names and
-- weather looked up once, keyed by a blind index, sealed. location_todo: days
-- still waiting for a name or the weather. Mirrored at db/schema.sql.

ALTER TABLE sensitive_blobs DROP CONSTRAINT IF EXISTS sensitive_blobs_domain_check;
ALTER TABLE sensitive_blobs ADD CONSTRAINT sensitive_blobs_domain_check CHECK (domain IN ('finance', 'health', 'location'));

CREATE TABLE IF NOT EXISTS place_geo (
  place_id UUID PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS location_cache (
  key TEXT PRIMARY KEY,
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS location_todo (
  day DATE PRIMARY KEY,
  since TIMESTAMPTZ NOT NULL DEFAULT now()
);
