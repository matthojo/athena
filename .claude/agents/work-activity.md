# Collection agent spec: work-activity

> **Status: spec only, not a live trigger.** This describes a future scheduled
> Claude Code agent. It is not registered as a cron job. Registering it is a
> separate, deliberate decision — see `README.md` and `ARCHITECTURE.md`
> ("Collection model: live query vs. scheduled snapshots").

## Purpose

Turn day-to-day engineering/work activity (issues, commits/PRs, relevant Slack
discussion) into a durable throughput record, so trend questions ("how many
issues did I close this week", "what did I ship in October") can be answered
from stored history instead of re-querying three different tools every time.

## Source MCP tools it calls (read-only)

- **Linear** — `mcp__claude_ai_Linear__list_issues`, scoped to the user
  (`assignee: "me"` or equivalent) and the collection window, to find issues
  created, updated, or completed. `mcp__claude_ai_Linear__list_comments` on
  issues worth summarizing, if comment activity itself is the signal (not just
  status changes).
- **GitHub** — either the `gh` CLI (`gh pr list --author=@me`,
  `gh search commits`, `gh pr view`) run via Bash, or a GitHub MCP connector
  if one is configured in the live session, to pull PRs opened/merged and
  commit activity for the window. The exact invocation should be confirmed
  against whichever is actually available when this agent runs — a GitHub MCP
  server wasn't confirmed present in the live session this spec was written
  against, so `gh` CLI is the safer default assumption.
- **Slack** — `mcp__claude_ai_Slack__slack_read_channel` (or
  `slack_search_public`/`slack_search_public_and_private`) scoped to
  channels/threads relevant to active projects, to surface decisions or
  blockers worth recording. This should stay narrow (specific channels or a
  search query tied to active project names) rather than scanning all of
  Slack — both for signal-to-noise and because broad Slack scraping is a
  heavier read than this agent's purpose justifies.

Double-check the exact Linear and Slack tool names above against what's
actually registered in the live session this agent runs in — tool names have
shifted across connector versions, and this spec was written from the
connector list available at spec-writing time (2026-11-04).

This agent never writes to Linear, GitHub, or Slack — read-only.

## What it writes to Athena (via the Athena MCP server)

- **One `metrics` point per day** for `issues_closed_day` (and optionally
  `prs_merged_day`) — via `upsert_metric`.
- **One `note` per notable unit of work** — a shipped feature, a closed
  project milestone, a significant PR — via `create_note`, with:
  - `type: "note"`
  - `source: "work-activity"`
  - `tags`: the relevant project name(s), Linear issue identifier(s)
  - `body`: a short summary of what changed and why, not a raw diff or issue
    dump
- **One `edge`** linking the note to the relevant `project` record (via
  `link`, `relation: "part_of"`), creating the `project` with `upsert_project`
  first if it doesn't exist yet.
- Routine activity with no durable value (a one-line typo-fix PR, a status
  comment with no decision in it) should be folded into the daily metric
  count rather than generating its own note — same principle as
  `calendar-meetings`: useful record, not a complete activity mirror.

## Writing style

Everything this agent writes in its own words (note titles and bodies,
to-do titles, catch-up summaries, facts, event notes) follows Athena's
writing style, `NOTE_STYLE` in `lib/writing-style.ts`: plain and specific,
like the owner's own notes, with no em dashes, no filler words ("delve",
"leverage", "pivotal") and no sum-up closers. Quotes and names copied from
the source stay as they are. The MCP server repeats the rules in its tool
descriptions and returns `style_issues` on a note that breaks them.

## Suggested cadence (suggested, not yet scheduled)

Daily, once per evening or the following morning, covering the prior day's
activity across all three sources.

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

From Slack threads and DMs (and Linear comments), record what's in motion.
Resolve people with `resolve_person` using their Slack handle (`slack`) or
email; teach Athena new handles with `add_identity`.

- **The owner promised something** ("I'll review it tomorrow"):
  `upsert_commitment` with `kind: "i_owe"` and the `person_id`.
- **The owner is waiting on someone** (asked, no answer, or "I'll get it to
  you"): `kind: "waiting_on"`.
- **Decisions reached in a thread:** `kind: "decision"`, rationale in `notes`.
- **Substantive DM conversations** (not a one-word reply): `log_interaction`
  with `channel: "message"`, `source_ref` = the thread permalink.

Provenance on every write (`source: "work-activity"`, `source_ref`,
`source_quote`). Write directly at confidence ≥ 0.8, otherwise `propose`.
