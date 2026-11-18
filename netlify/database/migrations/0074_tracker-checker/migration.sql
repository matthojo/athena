-- Who chose a tracker's checker (lib/trackers-store.ts; docs/team-notes/tracking-visible.md). `assistant_id` null meant
-- both "nobody chose yet" and the owner's "Just me"; this keeps them apart. NULL: nobody has chosen, so the first
-- assistant to keep a check on it takes it on. 'owner': the owner chose (an assistant, or "Just me" with
-- assistant_id null), and no assistant ever overwrites it. 'ask' / 'assistant': Ask gave it to one, or an assistant
-- started it or took it on.
ALTER TABLE trackers ADD COLUMN IF NOT EXISTS assistant_set_by TEXT CHECK (assistant_set_by IN ('owner', 'ask', 'assistant'));
-- Every tracker made before this one is the owner's choice (owner, 16 Nov 2026: "Mark them all as mine"): one with an
-- assistant keeps it, and one with none reads as "Just me", so no assistant takes it on unless the owner chooses.
UPDATE trackers SET assistant_set_by = 'owner' WHERE assistant_set_by IS NULL;
