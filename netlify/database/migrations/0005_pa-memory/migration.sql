-- Athena — layer 2, "what's in motion": open loops, interactions, facts,
-- identities, a review inbox for agent suggestions, life admin, reading,
-- goals, and ranked full-text search over notes.
-- Additive only, like 0002/0003: nothing existing is dropped or retyped.
-- Mirrored for reference at db/schema.sql — keep that file in sync.
--
-- Provenance columns (source, source_ref, source_quote, confidence) appear on
-- everything an agent can write: `source` is who wrote it ('manual' or an
-- agent name, like notes.source), `source_ref` where it came from (a URL or
-- 'note:<uuid>'), `source_quote` the exact words it was taken from, and
-- `confidence` 0..1 (null when the owner entered it). Agents write directly
-- only at >= 0.8; below that they file a `suggestions` row instead.

-- ---------- Commitments: todos, promises both ways, decisions ----------
-- kind: 'todo' (mine, no counterparty needed), 'i_owe' (I promised someone),
-- 'waiting_on' (someone promised me), 'decision' (recorded, not a loop).
-- person_id is the counterparty: owed to / waiting on / decided with.
CREATE TABLE commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo', 'i_owe', 'waiting_on', 'decision')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  due_on DATE,                 -- Europe/London local date
  notes TEXT NOT NULL DEFAULT '', -- context; the rationale for a decision
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  source TEXT,
  source_ref TEXT,
  source_quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  done_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commitments_open_idx ON commitments (due_on NULLS LAST, created_at)
  WHERE status = 'open' AND archived_at IS NULL;
CREATE INDEX commitments_person_idx ON commitments (person_id) WHERE archived_at IS NULL;
CREATE INDEX commitments_done_idx ON commitments (done_at DESC) WHERE status = 'done';
CREATE INDEX commitments_archived_idx ON commitments (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Interactions: every time you actually spoke ----------
-- Logging one moves each linked person's last_contacted_at forward (lib/db.ts).
CREATE TABLE interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL DEFAULT 'other' CHECK (channel IN ('meeting', 'call', 'message', 'email', 'in_person', 'other')),
  summary TEXT NOT NULL DEFAULT '',
  source TEXT,
  source_ref TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX interactions_at_idx ON interactions (at DESC) WHERE archived_at IS NULL;
CREATE INDEX interactions_archived_idx ON interactions (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE interaction_people (
  interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, person_id)
);
CREATE INDEX interaction_people_person_idx ON interaction_people (person_id);

-- ---------- Facts: small true things, with history ----------
-- One current value per (subject, key): adding a fact with the same key
-- supersedes the old one (superseded_at set) rather than overwriting it.
-- subject_kind 'me' is the owner's own profile (subject_id null).
CREATE TABLE facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('me', 'person', 'place', 'organisation')),
  subject_id UUID,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  source_ref TEXT,
  source_quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES facts(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((subject_kind = 'me') = (subject_id IS NULL))
);
CREATE INDEX facts_current_idx ON facts (subject_kind, subject_id, lower(key))
  WHERE superseded_at IS NULL AND archived_at IS NULL;
CREATE INDEX facts_archived_idx ON facts (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Identities: how to recognise a person in other systems ----------
-- Values are normalised on write (emails lowercased, phones digits only, names
-- trimmed + lowercased) so agents can resolve "priya@acme.com" or a Slack
-- handle to one person. people.email/phone are also checked when resolving.
CREATE TABLE identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'slack', 'alias', 'other')),
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
CREATE INDEX identities_person_idx ON identities (person_id);

-- ---------- Suggestions: the review inbox ----------
-- What an agent wasn't sure enough to write directly. Accepting applies
-- `payload` through the normal db layer; rejecting keeps the row (so the same
-- suggestion isn't filed again) and changes nothing else.
CREATE TABLE suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  op TEXT NOT NULL CHECK (op IN ('commitment', 'fact', 'interaction', 'event', 'person', 'link')),
  summary TEXT NOT NULL,       -- one human sentence: "You owe Priya the intro deck"
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT,
  source_ref TEXT,
  source_quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  result_id UUID,              -- what accepting created/updated
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suggestions_pending_idx ON suggestions (created_at DESC) WHERE status = 'pending';

-- ---------- Life admin: things that renew or expire ----------
-- Never store ID, policy or account numbers here: those belong in
-- sensitive_blobs (ciphertext). renews_on feeds Coming up and reminders.
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('passport', 'licence', 'insurance', 'vehicle', 'warranty', 'subscription', 'home', 'pet', 'health', 'other')),
  provider TEXT NOT NULL DEFAULT '',
  renews_on DATE,              -- renewal or expiry date, Europe/London local
  remind_days_before INT[] NOT NULL DEFAULT '{30,7,0}',
  notes TEXT NOT NULL DEFAULT '',
  sensitive_blob_id UUID REFERENCES sensitive_blobs(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assets_renews_idx ON assets (renews_on) WHERE archived_at IS NULL;
CREATE INDEX assets_archived_idx ON assets (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Reading list ----------
CREATE TABLE reading_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'book', 'podcast', 'video', 'paper', 'other')),
  author TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'reading', 'done')),
  notes TEXT NOT NULL DEFAULT '', -- highlights and takeaways, Markdown
  recommended_by UUID REFERENCES people(id) ON DELETE SET NULL,
  finished_at TIMESTAMPTZ,
  source TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reading_items_live_idx ON reading_items (status, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX reading_items_archived_idx ON reading_items (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Goals ----------
CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'quarter' CHECK (period IN ('week', 'month', 'quarter', 'year')),
  target TEXT NOT NULL DEFAULT '',   -- what "done" looks like, in words
  progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dropped')),
  due_on DATE,
  notes TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX goals_live_idx ON goals (status, due_on NULLS LAST) WHERE archived_at IS NULL;
CREATE INDEX goals_archived_idx ON goals (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Ranked full-text search over notes ----------
-- An expression index rather than a generated column, so `SELECT * FROM
-- notes` keeps returning exactly the shape the app already caches. Queries
-- must call athena_note_tsv(title, body) for the index to be used.
CREATE FUNCTION athena_note_tsv(title TEXT, body TEXT) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
            || setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'B') $$;
CREATE INDEX notes_fts_idx ON notes USING GIN (athena_note_tsv(title, body)) WHERE archived_at IS NULL;
