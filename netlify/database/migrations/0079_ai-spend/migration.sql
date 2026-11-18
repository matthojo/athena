-- AI spend (lib/spend.ts, docs/notes/models-spend.md): one row per model call, with what it cost in dollars at the
-- published prices (lib/model-prices.ts). `day` is the owner's own date when the call was made (settings.timezone),
-- so today's spend, and the midnight it starts again, follow their zone. Plain: model names, token counts and
-- money, nothing the owner wrote (lib/encryption-coverage.test.ts only scans files that seal, and lib/spend.ts
-- seals nothing). `assistant_id` has no foreign key: a deleted assistant's spend stays in the week's figures.
-- The daily budget is the plain settings row 'ai_budget' and the exchange rates the plain row 'fx_rate'.
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  day DATE NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('ask', 'assistant', 'background', 'pictures')),
  assistant_id UUID,
  job TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  audio_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  usd NUMERIC(14, 8) NOT NULL CHECK (usd >= 0),
  estimated BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ai_usage_day_idx ON ai_usage (day);
CREATE INDEX IF NOT EXISTS ai_usage_assistant_day_idx ON ai_usage (assistant_id, day) WHERE assistant_id IS NOT NULL;
