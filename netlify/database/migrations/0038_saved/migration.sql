-- Athena — Saved: links, images, quotes, snippets and notes kept from the
-- Share sheet, Siri, the browser extension and the app (lib/saved.ts,
-- lib/saved-rules.ts; SECURITY.md §11). Mirrored at db/schema.sql.
--
-- Sealed like note text (ENCRYPTED in lib/encryption.ts): url, title, site,
-- author, excerpt, readable (the page's clean text), quote, note, tags (each)
-- and source_url. url_bidx is a blind index of the link, so the same page
-- saved twice is one item. Kind, source, dates, the image's size and tone,
-- and flags stay readable for lists and the Day.
--
-- Image bytes are never here: they're sealed in the "athena-saved" blob store
-- (<id>/lg, <id>/sm); image_kid says which key sealed them.
-- saved_on is the owner's day at saving (their time zone), for the Day page.

CREATE TABLE IF NOT EXISTS saved_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('link', 'image', 'quote', 'snippet', 'note')),
  client_id UUID UNIQUE,
  url TEXT,
  url_bidx TEXT,
  title TEXT,
  site TEXT,
  author TEXT,
  published_on DATE,
  excerpt TEXT,
  readable TEXT,
  words INT,
  quote TEXT,
  note TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('shortcut', 'extension', 'share-target', 'app', 'email')),
  source_url TEXT,
  has_image BOOLEAN NOT NULL DEFAULT false,
  image_w INT,
  image_h INT,
  image_tone TEXT CHECK (image_tone IS NULL OR image_tone ~ '^#[0-9a-f]{6}$'),
  image_kid TEXT,
  fetch_status TEXT CHECK (fetch_status IS NULL OR fetch_status IN ('ok', 'preview', 'failed')),
  fetched_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_on DATE NOT NULL DEFAULT CURRENT_DATE,
  archived_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_items_live_idx ON saved_items (saved_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS saved_items_day_idx ON saved_items (saved_on);
-- Saves per caller per minute (POST /api/saved answers 429 over 60). bucket is a hash of the
-- caller's token, never the token; rows older than a few minutes are deleted as it goes.
CREATE TABLE IF NOT EXISTS saved_rate (
  bucket TEXT NOT NULL,
  minute TIMESTAMPTZ NOT NULL,
  n INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, minute)
);
CREATE INDEX IF NOT EXISTS saved_items_url_idx ON saved_items (url_bidx) WHERE url_bidx IS NOT NULL;
