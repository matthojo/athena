-- Athena — connectors and scheduled collections.
--
-- Athena signs in to remote MCP servers (Gmail, Google Calendar, Linear,
-- Slack, Granola, …) itself, as many accounts per service as you like
-- ("Work Gmail", "Personal Gmail"), and a scheduled function collects from
-- them into notes and metrics. See ARCHITECTURE.md "Connectors" and
-- SECURITY.md §9.
-- Additive only, like 0002/0003. Mirrored for reference at db/schema.sql.

-- ---------- Connectors: one row per signed-in account ----------
CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What you call it: "Work Gmail".
  name TEXT NOT NULL,
  -- A preset key from lib/connector-presets.ts ('gmail', 'linear', …) or 'custom'.
  provider TEXT NOT NULL DEFAULT 'custom',
  -- Which identity this is ('work', 'personal', or ''): suggested as the
  -- label for collections that read from it.
  account_label TEXT NOT NULL DEFAULT '',
  -- The MCP server's Streamable HTTP endpoint.
  url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('oauth', 'token', 'none')),
  -- OAuth scope to request ('' = whatever the server advertises).
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'needs_auth', 'error')),
  status_detail TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM ciphertext (lib/secret-box.ts) of a JSON object holding
  -- every secret for this account: static token, OAuth client registration,
  -- access/refresh tokens, PKCE verifier. Never returned by the API.
  credentials TEXT,
  -- SHA-256 of the OAuth `state` while a sign-in is in flight (cleared on
  -- callback). The raw state only ever exists in the user's browser redirect.
  oauth_state_hash TEXT UNIQUE,
  oauth_state_expires_at TIMESTAMPTZ,
  -- Tools the server offers: [{ name, description, access: 'read'|'write'|'unknown' }].
  tools JSONB NOT NULL DEFAULT '[]',
  -- The only tools a collection may call. Write tools can never be added.
  allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  tools_checked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Collections: what to collect, from which accounts, when ----------
CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- A recipe from netlify/lib/connectors/recipes.ts, or 'custom' (instructions only).
  recipe TEXT NOT NULL CHECK (recipe IN ('calendar-meetings', 'email-digest', 'work-activity', 'custom')),
  connector_ids UUID[] NOT NULL DEFAULT '{}',
  -- '' or e.g. 'personal': makes source 'email-digest-personal' and metric
  -- names '..._personal', so two accounts never merge or dedupe each other.
  label TEXT NOT NULL DEFAULT '',
  -- notes.source for everything this collection writes.
  source TEXT NOT NULL,
  -- Extra guidance (required for 'custom').
  instructions TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT 'daily' CHECK (schedule IN ('daily', 'hourly', 'manual')),
  -- 'daily': Europe/London local time.
  run_at TIME,
  -- 'hourly': every N hours.
  every_hours INT CHECK (every_hours IS NULL OR every_hours BETWEEN 1 AND 168),
  lookback_hours INT NOT NULL DEFAULT 36 CHECK (lookback_hours BETWEEN 1 AND 336),
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collections_due_idx ON collections (next_run_at) WHERE enabled AND schedule <> 'manual';

-- ---------- Runs: one per execution, kept as history ----------
CREATE TABLE collection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- The model's closing summary (counts, not content).
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  -- { tool_calls, notes_created, notes_updated, metrics, people, input_tokens, output_tokens, … }
  stats JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collection_runs_collection_idx ON collection_runs (collection_id, created_at DESC);
CREATE INDEX collection_runs_open_idx ON collection_runs (created_at) WHERE status IN ('queued', 'running');

-- ---------- Dedup: which source item became which note ----------
-- (source, external_id) — e.g. ('email-digest-personal', '<gmail thread id>')
-- — so a rerun updates the note it wrote before instead of writing another.
CREATE TABLE collected_items (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
