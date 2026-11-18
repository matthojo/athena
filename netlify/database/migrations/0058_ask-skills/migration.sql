-- Athena — Ask's skills (lib/skills.ts, lib/skills-store.ts).
--
-- SKILL.md instructions that change how Ask handles some requests. Each
-- skill's name, description, body, reference files and source are one
-- sealed JSON string in payload (SECURITY.md §11). Readable columns: the
-- switch, the starter key, the use count and times.
--
-- Additive only. Numbered 0058 (after main's 0057).
-- Mirrored at db/schema.sql.

CREATE TABLE IF NOT EXISTS ask_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  starter TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
