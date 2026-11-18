-- Athena — custom fields: the owner's own details on any kind of record
-- ("Shoe size" and "Interests" on people, "Rating" on the reading list).
--
-- The owner defines fields per kind in the app's Settings (or by asking
-- Athena in Ask); every record of that kind then shows them in its Details.
-- Fields are archived, never deleted: an archived field's values stay put and
-- come back with it.
--
-- Labels, units, options and values are the owner's content, so they're
-- sealed under ATHENA_DATA_KEY like the rest (SECURITY.md §11): `label`,
-- `unit` and each `value` hold "enc:v1:…" text once the key is set, and
-- `options` holds one sealed JSON string (like suggestions.payload). Nothing
-- here is compared, sorted or searched in SQL: labels are matched and values
-- searched in the Function. Kinds, types, positions and ids stay readable.
--
-- `kind` and `entity_kind` are a kind string, not a fixed list: a new built-in
-- kind (lib/custom-field-rules.ts FIELD_KINDS) needs no migration, and kinds
-- the owner makes later can use ids like 'custom:<uuid>' with these same
-- tables.
--
-- Numbered after 0015 (trips and purchases, still in review; 0013 and 0014 are
-- on main already), so it merges after them. Mirrored for reference
-- at db/schema.sql.

CREATE TABLE custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which kind of record it belongs to: 'person', 'reading', 'note', …
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_:-]{0,79}$'),
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'long_text', 'number', 'rating', 'boolean', 'date', 'link', 'choice', 'choices')),
  -- choice / choices: the list to pick from (a JSON array, or one sealed JSON string).
  options JSONB NOT NULL DEFAULT '[]',
  -- number: an optional unit, e.g. 'UK' or 'cm'.
  unit TEXT NOT NULL DEFAULT '',
  -- Order within the kind, as the owner arranged it.
  position INT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_fields_kind_idx ON custom_fields (kind, position) WHERE archived_at IS NULL;

-- One value per field per record: JSON text (a string, number, true/false or
-- a list of strings), sealed. No row means no value. Permanently deleting a
-- record deletes its values in the same statement as its edges (lib/db.ts).
CREATE TABLE custom_values (
  field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind ~ '^[a-z][a-z0-9_:-]{0,79}$'),
  entity_id UUID NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX custom_values_entity_idx ON custom_values (entity_kind, entity_id);
