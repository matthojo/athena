-- Athena — the settings row 'capture_keys' goes.
-- Safe to run twice. Mirrored at db/schema.sql (a note by the settings table).
--
-- Before API keys (lib/api-keys.ts), capture keys were kept in the settings row 'capture_keys', as SHA-256 hashes,
-- and moved into 'api_keys' when the keys were read. API keys are now kept as an HMAC under a subkey of
-- ATHENA_DATA_KEY, and a plain hash is never accepted, so these keys can't work again: the row is removed rather
-- than moved. The owner makes a new capture key in Settings → API keys. A copy without the row is unchanged.
DELETE FROM settings WHERE key = 'capture_keys';
