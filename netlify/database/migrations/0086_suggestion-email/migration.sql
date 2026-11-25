-- The email a review-inbox find came from (lib/suggestion-similar.ts SuggestionEmail): its sender, its subject and the
-- account it was read from, so "Ignore emails like this" can add a mail rule to that account and the Inbox can say
-- who sent it. One sealed JSON value, like `payload` (lib/encryption.ts). NULL for finds that weren't an email, and
-- for ones filed before this column. Additive only. Safe to run twice. Mirrored at db/schema.sql.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS email JSONB;
