-- An assistant's own skill (docs/team.md, "Skills"): the SKILL.md Athena
-- writes for one Team assistant at setup. It lives in ask_skills like any
-- other, owned by that assistant: its chats and runs always load it, main
-- Ask never lists or loads it, and it goes when the assistant goes.
ALTER TABLE ask_skills ADD COLUMN IF NOT EXISTS assistant_id UUID REFERENCES team_assistants(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS ask_skills_assistant_idx ON ask_skills (assistant_id) WHERE assistant_id IS NOT NULL;
