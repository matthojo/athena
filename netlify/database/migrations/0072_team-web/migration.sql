-- Whether a Team assistant may look things up online (docs/team-notes/web-runs.md):
-- search the web and read a page it found, in its runs, checks and chats, while
-- "Let Ask search the web" is on too. Off by default (owner, 16 Nov 2026);
-- setup suggests it when the job needs something online. Plain, like `allow`.
-- Numbered after 0071 (team run words). Safe to run twice.
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS web BOOLEAN NOT NULL DEFAULT false;
