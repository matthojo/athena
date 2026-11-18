-- Athena — initial schema.
-- Mirrored for reference at db/schema.sql — keep that file in sync if this one changes.

-- gen_random_uuid() is native to Postgres 13+, no pgcrypto extension needed
-- (and this environment's Postgres doesn't have pgcrypto available anyway).
CREATE EXTENSION IF NOT EXISTS vector; -- pgvector, confirmed supported on Netlify DB

-- Free-form written content: notes, daily rollups, project logs, area pages, captures.
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'daily', 'project', 'area', 'capture')),
  source TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_updated_idx ON notes (updated_at DESC);
CREATE INDEX notes_type_idx ON notes (type);

-- Lightweight personal CRM.
CREATE TABLE people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generic typed graph: any entity can relate to any entity, with a named relation.
CREATE TABLE edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('note', 'person', 'project')),
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('note', 'person', 'project')),
  target_id UUID NOT NULL,
  relation TEXT NOT NULL DEFAULT 'relates_to',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, target_type, target_id, relation)
);
CREATE INDEX edges_source_idx ON edges (source_type, source_id);
CREATE INDEX edges_target_idx ON edges (target_type, target_id);

-- Time-series: meeting load, issue throughput, finance trend points, habit counts, ...
CREATE TABLE metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX metrics_metric_time_idx ON metrics (metric, recorded_at DESC);

-- Chunked note content + embeddings, for semantic search over `notes`.
CREATE TABLE note_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (note_id, chunk_index)
);
CREATE INDEX note_chunks_embedding_idx ON note_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Finance/health content: ciphertext only, never plaintext.
CREATE TABLE sensitive_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('finance', 'health')),
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sensitive_blobs_domain_idx ON sensitive_blobs (domain, recorded_at DESC);
