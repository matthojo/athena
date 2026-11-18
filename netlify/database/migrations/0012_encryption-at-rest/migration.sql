-- Athena — personal content encrypted at rest (SECURITY.md §11).
--
-- The encryption itself happens in the Functions (lib/data-box.ts): a SQL
-- migration never sees the key, so none of the data is touched here. Rows
-- written before ATHENA_DATA_KEY is set stay readable as they are, and
-- netlify/functions/encrypt-data.ts seals them in the background once the
-- key is set. This migration only adds what that code needs and drops what
-- can no longer work.
--
--  1. Blind indexes: HMAC-SHA256 of a normalised value under a key derived
--     from ATHENA_DATA_KEY, so exact lookups — resolving "priya@acme.com" or
--     "Priya Shah" to a person, matching meeting attendees — still run in
--     SQL. They show which rows share a value, never the value. NULL until a
--     row is sealed; until then lookups compare the plain value instead.
--  2. The full-text index on notes, and its function, go: an index over
--     ciphertext finds nothing, and its lexemes were a readable copy of every
--     note. Recall now ranks decrypted rows in the Function
--     (lib/text-search.ts).
--  3. people(name) was indexed for sorting; names are sorted in the Function
--     now, so that index goes too.
--
-- Mirrored for reference at db/schema.sql.

ALTER TABLE people ADD COLUMN name_bidx TEXT;
ALTER TABLE people ADD COLUMN email_bidx TEXT;
ALTER TABLE people ADD COLUMN phone_bidx TEXT;
CREATE INDEX people_name_bidx_idx ON people (name_bidx);
CREATE INDEX people_email_bidx_idx ON people (email_bidx);
CREATE INDEX people_phone_bidx_idx ON people (phone_bidx);

ALTER TABLE identities ADD COLUMN value_bidx TEXT;
CREATE INDEX identities_value_bidx_idx ON identities (kind, value_bidx);

DROP INDEX IF EXISTS notes_fts_idx;
DROP FUNCTION IF EXISTS athena_note_tsv(TEXT, TEXT);
DROP INDEX IF EXISTS people_live_name_idx;
