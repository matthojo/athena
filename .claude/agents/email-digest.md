# Collection agent spec: email-digest

> **Status: spec only, not a live trigger.** This describes a future scheduled
> Claude Code agent. It is not registered as a cron job. Registering it is a
> separate, deliberate decision — see `README.md` and `ARCHITECTURE.md`
> ("Collection model: live query vs. scheduled snapshots").

## Purpose

Surface only what matters from recent email into Athena, as records it can
act on: things to do, orders and deliveries, bookings, appointments and
deadlines, renewals, and security or account alerts, plus the odd email
worth looking up later. Never every email as a note, and never archiving,
labeling, or sending anything on the user's behalf — a read-only digest, not
an inbox-management agent.

**Owner, 15 Nov 2026:** "We don't need to store every email as a note. But
things like todos / delivery notifications / triggers etc. are very
helpful." So a note is the exception (reference mail only, at most 5 a run,
enforced in code), and what email sets in motion becomes a structured record
that Team assistants' triggers can wait for. Notes in
`docs/notes/email-signal.md`.

## Source MCP tools it calls (read-only)

- **Gmail** — `mcp__claude_ai_Gmail__search_threads` to find threads from the
  collection window worth reviewing (e.g. unread, or matching
  receipt/action-item heuristics), `mcp__claude_ai_Gmail__get_thread` /
  `mcp__claude_ai_Gmail__get_message` to read full content of threads worth
  summarizing, and `mcp__claude_ai_Gmail__list_labels` to understand the
  user's existing label taxonomy (useful context for tagging notes
  consistently, not for applying Gmail labels).

This agent must **not** call any Gmail write tool —
`apply_sensitive_message_label`, `label_message`, `label_thread`,
`create_draft`, `send_message`, `reply`, `forward`, `trash_message`,
`mark_message_spam`, `update_draft`, `update_message_labels`, or any similar
mutating tool are all explicitly out of scope. This agent reads and digests;
it does not manage the inbox. If a future version of Athena wants
auto-archiving or auto-labeling, that's a different, separately-scoped agent
with its own explicit sign-off — not an extension of this one.

## What it writes to Athena (via the Athena MCP server)

- **A `note` only for reference mail** (a letter, a quote, terms the owner
  agreed to, a real person's reply with facts or decisions): something they'd
  want to look up later and can't easily get again. Via `create_note`, with:
  - `type: "note"`
  - `source: "email-digest"`
  - `tags`: the sender's organization plus `reference`
  - `body`: what's worth keeping and what (if anything) needs doing — not
    the full email body, and never the raw content of a financial email
  No note for a receipt, an FYI or anything the records below cover. Inside
  Athena (`netlify/lib/connectors/runner.ts`) a note tagged `fyi`, `receipt`
  or `action-item`, a `capture`, or a sixth new note in a run is refused with
  where it goes instead.
- **Things to do** (an ask, a form to sign, a bill to pay): a to-do
  (`athena_todo` / `upsert_commitment`, kind `todo`) with its due date.
- **Appointments and deadlines** that aren't travel: events (`athena_email_date`
  inside Athena, `upsert_event` over MCP), kind `appointment` or `deadline`.
- **Renewals and expiry notices**: Life admin (`athena_renewal` / `upsert_asset`
  with `renews_on`). Never a policy, licence, passport or account number.
- **Security and account alerts** (a new sign-in, a failed payment, an
  account locked): `athena_alert`, a to-do due today and a push.
- **One `metrics` point per day** for `emails_reviewed_day` and/or
  `action_items_found_day` — via `upsert_metric`, giving a rough sense of
  inbox load over time without storing every email as a note.
- **Travel bookings and orders** (flights, trains, hotels, car hire, event
  tickets; order confirmations and delivery updates) become **trips** and
  **purchases** when the email collection runs inside Athena
  (`netlify/lib/connectors/recipes.ts`: `athena_trip_booking`,
  `athena_purchase`). Over MCP they're read-only (`list_trips`,
  `list_purchases`), so this routine notes them as receipts and leaves the
  structured records to that collection. Never prices, totals or card details.
- **No `edge` creation is required by default** for this agent, since most
  email doesn't map cleanly onto a `person`/`project` record, but linking a
  note to an existing `project` (via `link`) is reasonable when a thread is
  clearly project-related and that project already exists in Athena.

### Finance-adjacent emails

An email that is itself a financial record (a bank statement, an investment
confirmation, a bill with an actual balance/amount in it) is **finance data**,
not a generic note. This agent never writes real figures from such an email
into a `note` (note text is not a place for amounts, see `finance.md`). At
most, flag the thread's existence as a note with no amounts in it.

## Writing style

Everything this agent writes in its own words (note titles and bodies,
to-do titles, catch-up summaries, facts, event notes) follows Athena's
writing style, `NOTE_STYLE` in `lib/writing-style.ts`: plain and specific,
like the owner's own notes, with no em dashes, no filler words ("delve",
"leverage", "pivotal") and no sum-up closers. Quotes and names copied from
the source stay as they are. The MCP server repeats the rules in its tool
descriptions and returns `style_issues` on a note that breaks them.

## Suggested cadence (suggested, not yet scheduled)

Daily, once per morning, covering roughly the prior 24 hours of inbox
activity.

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

Beyond the digest note, record what email set in motion. Resolve people with
`resolve_person` (by sender/recipient email) before writing about them.

- **Sent mail with a promise** ("I'll get back to you by Friday"):
  `upsert_commitment` with `kind: "i_owe"`, `person_id`, `due_on` if stated.
- **Asks you're waiting on** (you asked; no reply yet): `kind: "waiting_on"`.
  When the reply arrives, close it with `upsert_commitment` (`id`,
  `status: "done"`).
- **Real two-way threads with a person** (not newsletters or notifications):
  `log_interaction` with `channel: "email"`, `source_ref` = the thread id.
- **Bookings and tickets** (restaurants, travel, theatre, appointments):
  `upsert_event` with `kind: "appointment"`, `date` and `time`. If you're not
  sure of the details, `propose` with `op: "event"`.
- **Renewal and expiry notices** (insurance, MOT, passport, subscriptions):
  `upsert_asset` with `renews_on`. Never copy policy, licence, passport or
  account numbers into Athena.

Provenance on every write: `source: "email-digest"` (or your configured
label), `source_ref` = the thread id, `source_quote` = the exact sentence.
Write directly only at confidence ≥ 0.8; otherwise `propose`. Receipts and
anything financial still go through the finance rules, never plaintext.
