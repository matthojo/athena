-- Athena — acquaintances: people you keep in the CRM (who they are, where you
-- met, their birthday) but don't need nudging to catch up with. Every
-- catch-up read path (listStalePeople: Home's Coming up, the morning
-- briefing, push reminders, MCP list_upcoming) skips them.
-- Additive only, like 0002. Mirrored for reference at db/schema.sql.
ALTER TABLE people ADD COLUMN acquaintance BOOLEAN NOT NULL DEFAULT false;
