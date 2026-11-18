# Collection agent spec: finance

> **Status: spec only, not a live trigger.** This describes a future scheduled
> Claude Code agent. It is not registered as a cron job. Registering it is a
> separate, deliberate decision — see `README.md` and `ARCHITECTURE.md`
> ("Collection model: live query vs. scheduled snapshots").

## Purpose

Record a periodic financial snapshot (business balance today; personal
accounts once a connector exists) as encrypted history in Athena, without ever
putting a real figure into a plaintext field.

## Source MCP tools it calls (read-only)

- **Stripe** — `mcp__claude_ai_Stripe__get_balance_summary` for the current
  available/pending balance, and `mcp__claude_ai_Stripe__stripe_analytics` for
  trend data (revenue, payout history) over the collection window.

This covers **business-side balance only**. Stripe alone cannot see personal
bank or investment accounts, so a real "finance" picture of the user's actual
net worth / personal cash position is not available through any currently
connected MCP tool. A future connector — e.g.
[SimpleFIN](https://www.simplefin.org/) for personal bank/investment
aggregation, or a direct bank API if one becomes available — is needed before
this agent can honestly claim to track personal finances rather than just
Stripe's business balance. This spec is written against what's available
today (Stripe only); treat the personal-finance half of "finance agent" as
unimplemented until that connector exists.

This agent never writes to Stripe — read-only.

## What it writes to Athena (via the Athena MCP server)

This is the one collection domain where the plaintext/ciphertext boundary from
`SECURITY.md` is load-bearing, so it's spelled out explicitly:

- **Any actual balance, revenue, or transaction figure** pulled from
  `get_balance_summary` or `stripe_analytics` is **never written to Athena**.
  No MCP tool can seal a figure: Athena seals money only through its own
  code paths (`SECURITY.md` §1), never through a model. So the figures stay
  in this run and are dropped when it ends.
  - **These figures must never go through `create_note` or `upsert_metric`.**
    Both store readable text, and a dollar amount in a note body or a
    metric value defeats the encryption boundary this system is built
    around. This is the one rule in this spec that should never be relaxed
    for convenience.
- **A coarse, non-sensitive derived signal** may go through the normal
  note/metric path, because it carries no figures and isn't sensitive on its
  own:
  - A `note` via `create_note`, `type: "note"`, `source: "finance"`, body
    along the lines of *"Finance snapshot taken"*
    (no numbers, no currency, no trend direction even — "recorded" only).
  - A `metrics` point via `upsert_metric` for something like
    `finance_snapshot_taken_day` with `value: 1` (a presence/heartbeat signal,
    not a magnitude) — useful for confirming the agent ran, not for charting
    actual finances.
- If/when a personal-finance connector (SimpleFIN or similar) is added, the
  same rule applies without exception: real figures are read and sealed by
  Athena's own code, the way Monzo and Starling are (`money-sync.ts`), never
  handed to a model to write.

## Writing style

Everything this agent writes in its own words (note titles and bodies,
to-do titles, catch-up summaries, facts, event notes) follows Athena's
writing style, `NOTE_STYLE` in `lib/writing-style.ts`: plain and specific,
like the owner's own notes, with no em dashes, no filler words ("delve",
"leverage", "pivotal") and no sum-up closers. Quotes and names copied from
the source stay as they are. The MCP server repeats the rules in its tool
descriptions and returns `style_issues` on a note that breaks them.

## Suggested cadence (suggested, not yet scheduled)

Daily, once per day (e.g. overnight), since balance data doesn't need
hourly resolution for a personal system. A weekly or monthly rollup note
(still through the encrypted path for any actual figures) is a reasonable
addition once daily snapshots are flowing.

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
