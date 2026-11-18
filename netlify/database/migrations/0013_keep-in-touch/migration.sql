-- Athena — catch-up nudges become opt-in. People start with nudges off; you
-- turn on "Keep in touch" for the ones you want reminding about. Every
-- catch-up read path (listStalePeople: Home's Coming up, the morning
-- briefing, push reminders, MCP list_upcoming) now reads keep_in_touch.
--
-- Existing people keep nudges only where you'd chosen a cadence for them
-- (and hadn't marked them an acquaintance). `acquaintance` stays for now,
-- unread, so the old deploy keeps working until this one goes live; a later
-- migration drops it. Mirrored for reference at db/schema.sql.
ALTER TABLE people ADD COLUMN keep_in_touch BOOLEAN NOT NULL DEFAULT false;
UPDATE people SET keep_in_touch = true WHERE catch_up_days IS NOT NULL AND NOT acquaintance;
