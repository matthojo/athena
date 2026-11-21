-- Flow suggestions (lib/flow-suggest.ts): a suggestion the owner dismissed never comes back.
-- `id` names the kind of habit ("follow-delivery-reminder", "saved-book-watch_read"); one built on
-- the owner's own words carries a short SHA-256 of them instead ("repeat-reminder-3f2a9c41d0b7"),
-- never the words. Plain: no data-key text. Additive only.
CREATE TABLE IF NOT EXISTS flow_suggestion_dismissals (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{3,80}$'),
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
