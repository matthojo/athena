-- Athena — health days, sealed.
--
-- One row per day and source (Apple Health through the iPhone Shortcut,
-- Strava, Oura, Withings) in sensitive_blobs, the one place health figures
-- may live (SECURITY.md §1). The figures are JSON sealed under the data key
-- (lib/health.ts); the label says only the day and the source.
--
-- Adds `day` and `source`, one row per (domain, source, day), and a check
-- that a health day is always sealed, so plaintext can't be stored even by
-- mistake. Rows without a day (finance, older health blobs) are untouched.
-- Numbered after 0021 (Life log). Mirrored at db/schema.sql.

ALTER TABLE sensitive_blobs ADD COLUMN IF NOT EXISTS day DATE;
ALTER TABLE sensitive_blobs ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE sensitive_blobs ADD CONSTRAINT sensitive_blobs_day_sealed
  CHECK (day IS NULL OR (source ~ '^[a-z_]{2,30}$' AND ciphertext LIKE 'enc:v1:%'));
CREATE UNIQUE INDEX IF NOT EXISTS sensitive_blobs_day_idx ON sensitive_blobs (domain, source, day) WHERE day IS NOT NULL;
