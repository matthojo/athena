# Collection agent spec: calendar-ahead

> **Status: spec only, not a live trigger.** Registering it as a scheduled
> Claude routine is a separate, deliberate decision (see `README.md`,
> "Collection agents"). It needs the Athena MCP connector.

## Purpose

Put the next week's meetings into Athena as dated events, linked to the
people in them, so the morning briefing lists them and the push 30 minutes
before each one says who it's with, when you last spoke, and what's open
between you ("At 14:00 with Marcus · last spoke 96 days ago · you said you'd
send the hiring rubric").

## Source MCP tools (read-only)

- **Google Calendar** — `list_events` for the next 7 days (Europe/London),
  `get_event` for attendees.

Never writes to Calendar.

## What it writes to Athena

For each meeting with at least one other attendee (skip focus blocks,
holds, all-hands with more than ~8 people, and declined events):

1. **The event:** `upsert_event` with `kind: "appointment"`, `title`, `date`
   and `time` (24h, local). Find an existing one first with
   `search_entities` (`kinds: ["event"]`, the title) and update it by `id`
   if the date matches, so reruns and reschedules don't duplicate. Put the
   calendar event id in `notes` as `calendar:<id>`.
2. **Its people:** `resolve_person` each attendee by email; `upsert_person`
   only when there's no match (then `add_identity` with the email). Link
   each one: `link` with `sourceType: "event"`, `targetType: "person"`,
   `relation: "with"`.
3. **Cancelled meetings:** `archive` the event (never delete).

## Writing style

Everything this agent writes in its own words (note titles and bodies,
to-do titles, catch-up summaries, facts, event notes) follows Athena's
writing style, `NOTE_STYLE` in `lib/writing-style.ts`: plain and specific,
like the owner's own notes, with no em dashes, no filler words ("delve",
"leverage", "pivotal") and no sum-up closers. Quotes and names copied from
the source stay as they are. The MCP server repeats the rules in its tool
descriptions and returns `style_issues` on a note that breaks them.

## Cadence (suggested)

Every 3 hours during the day, covering today and the next 7 days.

## Rules

- Provenance where the tools accept it; never delete; never copy
  meeting-link URLs with passcodes into notes.
- Don't create events for meetings already in the past.
