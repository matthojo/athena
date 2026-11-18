-- Athena — which credential registered a push subscription (security review M5).
--
-- A fingerprint of the master token or API key the subscribing request
-- carried (lib/push.ts, never the token or its stored hash). Before each
-- send, subscriptions whose credential has been removed or changed are
-- dropped, so a token that was held briefly stops receiving notification
-- text once it is rotated. Rows from before this column have no credential
-- and are dropped the same way; the device subscribes again from
-- Settings → Notifications.
--
-- Additive only. Numbered 0057 (third free number after main's 0054).
-- Mirrored at db/schema.sql.

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS credential TEXT;
