-- Athena — what an MCP server says about itself in its `initialize` reply
-- (serverInfo: title, description, website, icons), so custom connectors get
-- their own logo and name in the app. Icons are fetched once, server-side,
-- and kept as small data: URIs, so the app never contacts third parties for
-- them. Shape: { name, title, version, description, website_url,
--                icon: { light?: "data:…", dark?: "data:…", source: "server"|"website" } }
-- Additive only. Mirrored for reference at db/schema.sql.
ALTER TABLE connectors ADD COLUMN server_info JSONB NOT NULL DEFAULT '{}';
