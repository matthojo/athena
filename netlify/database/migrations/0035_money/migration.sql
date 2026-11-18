-- Athena — money and home days, sealed; habits on Days (lib/money.ts, SECURITY.md §1).
--
-- Money: one sensitive_blobs row per (domain 'money', source, day) from a
-- bank account (Monzo, Starling): spend per category, count, merchants and
-- times, as JSON sealed under the data key. Home: one row per (domain
-- 'home', source 'octopus', day) with the day's kWh by half hour, because
-- half-hourly use shows when someone's home. The label is the day and the
-- source, never an amount or a merchant.
--
-- The check below refuses a money or home row that has no day or isn't
-- sealed, so plaintext can't be stored even by mistake (the 0028 check only
-- covers rows that have a day).
--
-- day_entries: a new kind 'habit' (Habitify, Todoist routines, Loop), whose
-- count is 1 for done and 0 for not done (0034 already allows a count of 0).
-- Mirrored at db/schema.sql.

ALTER TABLE sensitive_blobs DROP CONSTRAINT IF EXISTS sensitive_blobs_domain_check;
ALTER TABLE sensitive_blobs ADD CONSTRAINT sensitive_blobs_domain_check CHECK (domain IN ('finance', 'health', 'location', 'money', 'home'));
ALTER TABLE sensitive_blobs DROP CONSTRAINT IF EXISTS sensitive_blobs_money_sealed;
ALTER TABLE sensitive_blobs ADD CONSTRAINT sensitive_blobs_money_sealed
  CHECK (domain NOT IN ('money', 'home') OR (day IS NOT NULL AND source ~ '^[a-z_]{2,30}$' AND ciphertext LIKE 'enc:v1:%' AND label !~ '[0-9]+\.[0-9]{2}|£|\$|€'));

ALTER TABLE day_entries DROP CONSTRAINT IF EXISTS day_entries_kind_check;
ALTER TABLE day_entries ADD CONSTRAINT day_entries_kind_check
  CHECK (kind IN ('watched', 'listened', 'read', 'highlight', 'played', 'posted', 'saved', 'chess', 'workout', 'habit', 'other'));
