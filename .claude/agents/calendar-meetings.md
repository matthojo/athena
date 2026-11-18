# Collection agent spec: calendar-meetings

> **Status: spec only, not a live trigger.** This describes a future scheduled
> Claude Code agent. It is not registered as a cron job. Registering it is a
> separate, deliberate decision — see `README.md` and `ARCHITECTURE.md`
> ("Collection model: live query vs. scheduled snapshots").

## Purpose

Turn the user's calendar and meeting history into durable Athena records —
meeting notes, attendee links, and a weekly meeting-load trend — so questions
like "how has my meeting load changed this quarter" and "what did I agree to
in that meeting with X" can be answered from stored data instead of a live
API call.

## Source MCP tools it calls (read-only)

- **Google Calendar** — `mcp__claude_ai_Google_Calendar__list_events` to pull
  events for the collection window (e.g. the prior day or week), and
  `mcp__claude_ai_Google_Calendar__get_event` for full detail (attendees,
  description) on events worth recording. `mcp__claude_ai_Google_Calendar__search_events`
  may be used to backfill a specific past meeting.
- **Granola** — `mcp__claude_ai_Granola__list_meetings` (or
  `get_meetings`) to find meetings with notes/transcripts for the window, and
  `mcp__claude_ai_Granola__get_meeting_transcript` when the calendar event
  alone doesn't carry enough content to produce a useful note (decisions,
  action items). `mcp__claude_ai_Granola__search_transcripts` may be used to
  answer a specific follow-up question about what was said.

These are the connector and tool names available in the current environment,
confirmed against a live session at spec-writing time (2026-11-04). Google
Calendar's names are stable; double-check the exact Granola tool names
(`list_meetings` vs. `get_meetings`) against what's actually available in the
live session this agent eventually runs in, since Granola's MCP surface has
changed across rounds.

This agent never writes to Calendar or Granola — read-only.

## What it writes to Athena (via the Athena MCP server)

- **One `metrics` point per day** for `meeting_hours_week` (or
  `meeting_count_day`, whichever proves more useful) — via `upsert_metric`,
  with `metadata` noting the date range covered. This is what powers the
  meeting-load trend view.
- **One `note` per meeting** that has enough content to be worth recording
  (has a Granola transcript/summary, or a calendar description beyond a bare
  title) — via `create_note`, with:
  - `type: "note"`
  - `source: "calendar-meetings"`
  - `tags`: topical tags only, inferable from the content (e.g. project
    names mentioned). Never people: attendees are linked to the note, and a
    tag that's a linked person's name is dropped automatically.
  - `body`: a short summary (decisions, action items) rather than a raw
    transcript dump — the transcript itself stays in Granola; Athena stores
    the distilled version.
- **One `edge` per attendee**, linking the meeting note to that attendee's
  `person` record — via `link`, with `relation: "attended_with"` (or similar).
  If the attendee doesn't yet have a `person` record, this agent should call
  `upsert_person` first to create one (name only is fine; it doesn't need to
  backfill history).
- Meetings that are pure noise (e.g. a recurring 1:1 placeholder with no
  content at all) should be skipped rather than creating an empty note for
  every calendar entry — the point is a useful record, not a complete
  calendar mirror.

## Writing style

Everything this agent writes in its own words (note titles and bodies,
to-do titles, catch-up summaries, facts, event notes) follows Athena's
writing style, `NOTE_STYLE` in `lib/writing-style.ts`: plain and specific,
like the owner's own notes, with no em dashes, no filler words ("delve",
"leverage", "pivotal") and no sum-up closers. Quotes and names copied from
the source stay as they are. The MCP server repeats the rules in its tool
descriptions and returns `style_issues` on a note that breaks them.

## Suggested cadence (suggested, not yet scheduled)

Daily, once per morning, covering the prior day's meetings. A weekly rollup
run (computing/upserting the week's aggregate `meeting_hours_week` metric) is
a reasonable addition once the daily version is working, but isn't required
to start.

## Linking in note bodies

Note bodies are Markdown. When a note mentions a person, place,
organisation, event or another note that exists in Athena, link it inline
with Athena's link syntax instead of (or as well as) calling `link`:

```
[@Priya Shah](athena://person/<uuid>)
[@Dishoom](athena://place/<uuid>)
[@Netlify](athena://organisation/<uuid>)
[@Mum's birthday](athena://event/<uuid>)
[Q3 planning](athena://note/<uuid>)
```

- Entity labels start with `@`; note labels don't.
- Find ids with `search_entities` (e.g. `{ "query": "Priya", "kinds": ["person"] }`).
  If someone or something isn't there yet, create it first with
  `upsert_person` / `upsert_place` / `upsert_organisation` / `upsert_event`,
  then use the returned id.
- Saving the note derives its `mentions` links from these automatically,
  which is what shows up as backlinks ("Notes mentioning this") in the app.
  Use `link` only for relationships that aren't a mention in a body
  (e.g. person `works_at` organisation).
- Never delete anything (there's no tool for it). If something is wrong or
  obsolete, fix it with an update, or `archive` it.

## What's in motion (layer 2, 2026-11-05)

After writing a meeting's note, record what the meeting set in motion.

1. **Resolve every attendee** with `resolve_person` (the invite email first,
   then the name). Only `upsert_person` when there's no match, and teach
   Athena any new email with `add_identity`.
2. **The meeting itself:** one `log_interaction` with everyone resolved —
   `channel: "meeting"`, `at` = the start time, a one-sentence `summary`,
   `source: "calendar-meetings"`, `source_ref` = the Granola meeting id (or the
   calendar event id). Re-running with the same `source_ref` updates rather
   than duplicates. This is what clears people from catch-up nudges.
3. **To-dos for someone** — what the owner said they'd do ("I'll send you…",
   "let me intro you…"): `upsert_commitment` with `kind: "i_owe"`,
   `person_id`, and `due_on` if a date was said. The app shows these under
   **To do** as "For Priya".
4. **Waiting on** — what others promised the owner: `kind: "waiting_on"`.
5. **Decisions** — `kind: "decision"`, with the why in `notes`.
6. **Facts** — durable personal details that came up ("Maya started
   school", "moving to Lisbon in the spring"): `add_fact` on the person with a
   short sentence-case `key`.

Every write carries `source`, `source_ref` and the exact `source_quote` from
the transcript. Write directly only when confidence is at least 0.8; below
that, call `propose` with the same fields as its payload, and the owner
decides in the app's Review inbox. Never extract finance, health or ID
numbers.
