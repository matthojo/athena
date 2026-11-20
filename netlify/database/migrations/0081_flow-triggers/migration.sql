-- Flows' triggers (lib/flow-triggers.ts, lib/flow-triggers-db.ts).
--
-- `team_events.flow_claimed_at`: flows claim each event with their own column, beside Team's `processed_at`, so
-- both see every event once and neither takes one from the other. Events kept before this migration are marked
-- seen: no flow existed when they arrived.
--
-- `flow_trigger_fires`: one row per fire a flow has claimed (a schedule slot, "15 minutes before" one event,
-- "3 days before" one date), so overlapping passes start it once. Plain: a flow's id, a key made of a kind, a
-- record's id and a time, and timestamps; never a title. `flow_id` has no foreign key, so this doesn't depend on
-- the flows table; rows go after a week (FIRE_DAYS), and with their flow when it's deleted, by the engine.
ALTER TABLE team_events ADD COLUMN IF NOT EXISTS flow_claimed_at TIMESTAMPTZ;
UPDATE team_events SET flow_claimed_at = now() WHERE flow_claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS team_events_flow_pending_idx ON team_events (id) WHERE flow_claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS flow_trigger_fires (
  flow_id TEXT NOT NULL,
  fire_key TEXT NOT NULL,
  fire_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, fire_key)
);
CREATE INDEX IF NOT EXISTS flow_trigger_fires_at_idx ON flow_trigger_fires (fire_at);
