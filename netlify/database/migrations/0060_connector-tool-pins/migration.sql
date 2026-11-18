-- Athena — custom MCP servers, isolated and pinned (security review M9, M10;
-- lib/connectors.ts). Mirrored at db/schema.sql. Safe to run twice.

-- Each allowed tool's text hash (description + input schema) at the moment
-- the owner allowed it: { "<tool name>": "<sha256>" }. A custom server's tool
-- whose text no longer matches is kept from the model until approved again.
-- Accounts that exist now keep NULL: their allowed tools stay allowed and
-- are pinned at their current text on the next listing. New accounts get {}.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS tool_pins JSONB;
ALTER TABLE connectors ALTER COLUMN tool_pins SET DEFAULT '{}';

-- Custom servers only, both off by default (also for servers already connected):
-- offer its tools to Ask's answers; let it share a collection with other accounts.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS use_in_ask BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS share_collections BOOLEAN NOT NULL DEFAULT false;
