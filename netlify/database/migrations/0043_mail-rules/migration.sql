-- Athena — which emails a Gmail or Outlook account lets Athena read
-- (lib/mail-rules.ts; enforced in google-gmail.ts and microsoft-mail.ts).
--
-- `mail_rules` is one JSON value (inbox only, senders, subjects, labels)
-- sealed under the data key: senders can be people's addresses. NULL = no
-- rules. `mail_skips` counts emails the rules kept from collection runs, per
-- account and day: counts only, never which emails.
--
-- Additive only. Numbered after 0043 and 0044 (parallel work). Mirrored at
-- db/schema.sql.

ALTER TABLE connectors ADD COLUMN IF NOT EXISTS mail_rules TEXT;
ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_mail_rules_sealed;
ALTER TABLE connectors ADD CONSTRAINT connectors_mail_rules_sealed CHECK (mail_rules IS NULL OR mail_rules LIKE 'enc:v1:%');

CREATE TABLE IF NOT EXISTS mail_skips (
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  n INT NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (connector_id, day)
);
