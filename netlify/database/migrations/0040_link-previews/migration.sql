-- Athena — link previews for rich links in notes (lib/link-previews.ts,
-- docs/notes/rich-links-stage1.md; SECURITY.md §11). Mirrored at db/schema.sql.
--
-- One row per web address that a note shows as a Card (or a Mention with its
-- favicon), read once through Saved's guarded page fetch. It is a cache: no
-- note points at a row, and a row can be dropped and read again.
--
-- url_bidx is a blind index of the normalised address. The address itself
-- isn't kept: every request brings it. Sealed under the data key: title,
-- summary, site_name, author, kind and facts (JSON). Readable: status,
-- fetched_at (last good read), checked_at (last try), and the picture's size
-- and average colour, as Saved keeps them (the card's shape and tint).
-- Athena writes rows only with the data key set.
--
-- Picture and favicon bytes are never here: they're sealed in the
-- "athena-link-previews" blob store (<id>/image, <id>/favicon), re-encoded
-- as WebP with metadata dropped; image_kid and favicon_kid say which key.

CREATE TABLE IF NOT EXISTS link_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url_bidx TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  title TEXT,
  summary TEXT,
  site_name TEXT,
  author TEXT,
  kind TEXT,
  facts TEXT,
  has_image BOOLEAN NOT NULL DEFAULT false,
  image_w INT,
  image_h INT,
  image_tone TEXT CHECK (image_tone IS NULL OR image_tone ~ '^#[0-9a-f]{6}$'),
  image_kid TEXT,
  has_favicon BOOLEAN NOT NULL DEFAULT false,
  favicon_kid TEXT,
  fetched_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_previews_checked_idx ON link_previews (checked_at);
