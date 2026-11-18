# Collection agent spec: inbox-triage

> **Status: spec only, not a live trigger.** Registering it as a scheduled
> Claude routine is a separate, deliberate decision (see `README.md`,
> "Collection agents"). It needs the Athena MCP connector.

## Purpose

Quick captures are written in a hurry: "remind me to book the MOT",
"Priya's daughter is called Maya", "dentist moved to Thursday 9:30". This
agent reads new captures and files what's in them where Athena can act on
it, without touching the capture itself.

## Source

Athena only: `list_notes` with `type: "capture"` and `since` = the last run
(the previous hour).

## What it writes

- **"Remind me to…", "I need to…", "Don't forget…"** → `upsert_commitment`
  (`kind: "todo"`, `due_on` when a day is named; `kind: "i_owe"` with the
  person when it's for someone).
- **"X is waiting for…", "X will send me…"** → `kind: "waiting_on"`.
- **A personal detail about someone** → `add_fact` on that person (after
  `resolve_person`).
- **A dated thing** ("dentist Thursday 9:30") → `upsert_event` (update an
  existing one if it's a move).
- **Something to read, watch, listen to or play** (a link with "read later", a
  film or show someone recommended) → `upsert_reading_item` (the Watch & read
  list), with the right `kind`.

Every write: `source: "inbox-triage"`, `source_ref: "note:<capture id>"`,
`source_quote` = the capture's words. Write directly only at confidence ≥
0.8; otherwise `propose`, so the owner confirms it in the Review inbox.
Never edit, archive or delete the capture — it stays as written.

## Writing style

Everything this agent writes in its own words (note titles and bodies,
to-do titles, catch-up summaries, facts, event notes) follows Athena's
writing style, `NOTE_STYLE` in `lib/writing-style.ts`: plain and specific,
like the owner's own notes, with no em dashes, no filler words ("delve",
"leverage", "pivotal") and no sum-up closers. Quotes and names copied from
the source stay as they are. The MCP server repeats the rules in its tool
descriptions and returns `style_issues` on a note that breaks them.

## Cadence (suggested)

Hourly, 07:00–22:00 Europe/London.
