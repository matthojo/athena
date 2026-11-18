-- Check-ins (lib/checkins.ts; the contract is lib/checkin-types.ts): a morning preparation and an evening
-- reflection, one row per (date, kind). The day's plan (its questions as they were when it was made) and the
-- answers are sealed together in `sealed`, under the data key like a health day: written only with the key,
-- refused without it. `status` and `done_at` stay readable so a calendar or a streak can be drawn without
-- opening anything. The settings (which questions, how many a day) are the plain settings row 'checkins'.
CREATE TABLE IF NOT EXISTS checkins (
  date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
  sealed TEXT NOT NULL CHECK (sealed LIKE 'enc:v1:%'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, kind)
);
CREATE INDEX IF NOT EXISTS checkins_updated_idx ON checkins (updated_at);
