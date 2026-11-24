# Athena — Architecture

Athena is a personal "second brain": a system that collects information from the
user's accounts and manual input, stores it durably and securely, visualizes it
like a dashboard, and can be queried and added to from a phone as well as a Mac,
open to other tools via a real connector — not a one-off artifact or a folder of
markdown files.

This document describes the architecture as built. For the security model in
detail (encryption, key custody, access control), see `SECURITY.md`. For setup
and day-to-day usage, see `README.md`.

## Design history, briefly

The design went through a few rounds before landing here. The decisions that
shaped the current shape:

- **No iCloud folder as the data store.** No markdown vault, no file-based
  source of truth, no git-as-sync-bridge. This repository is an ordinary code
  repository (the Netlify site: dashboard, functions, schema, docs) — it
  happening to sit in iCloud Drive is incidental, not architectural.
- **Netlify DB has no cost concern** for this project — it runs on an account
  where the usual credit-plan tradeoffs that push toward lighter-weight options
  don't apply. That removed a reason to hedge toward something smaller.
- **Mobile access is a proper offline-capable app**, not "edit files that
  happen to sync via iCloud." Local storage lives on-device and syncs to the
  cloud database.
- **Obsidian is an export format**, not a live surface — useful for
  portability, backup, and occasional browsing, not something the architecture
  depends on.
- **Multiple interaction surfaces are fine** for querying and creating — the
  system doesn't need to be one monolithic app.

Carried forward from earlier rounds and still true: Netlify DB as the
structured/graph store, the Athena MCP server as the one write gateway, four
priority collection domains (calendar + meetings, work activity, email digest,
finance), finance and health content encrypted at rest, and one GitHub repo
for the code.

## Single source of truth: Netlify DB (Postgres)

There is exactly one data store, so there's no sync-direction ambiguity to
reason about. The schema (`db/schema.sql`, a rolled-up reference mirroring the
real migrations under `netlify/database/migrations/`) has these tables:

- **`notes`** — free-form written content: notes, daily rollups, project logs,
  area pages, quick captures. Typed (`note` / `daily` / `project` / `area` /
  `capture`), tagged, sourced (`manual`, `calendar-meetings`, `work-activity`,
  `email-digest`, `finance`, ...).
  Bodies are Markdown (see "Links between things" below).
- **`people`** — a lightweight personal CRM: relationship, email, phone,
  `last_contacted_at` and a per-person `catch_up_days` cadence (null = 60) for
  the "haven't talked to X in a while" nudge. That nudge is opt-in:
  only people with `keep_in_touch = true` (off by default, since 0013) come
  up for a catch-up (`listStalePeople` filters on it, so Coming up, the
  briefing, pushes and MCP `list_upcoming` all agree). A person's birthday is not a
  column — it's their `events` row (see below); where they work is a manual
  `works_at` edge to an organisation.
- **`projects`** — active/paused/done tracking for anything ongoing.
- **`places`** and **`organisations`** — restaurants, homes, venues; companies,
  clubs, schools. Name plus a few fields and free notes.
- **`events`** — every date Athena knows: birthdays, anniversaries,
  appointments, deadlines. A timed one-off has `starts_at`, a UTC instant
  that the app shows in the device's time zone. A birthday, all-day event or
  deadline is a plain `date`, which is never shifted between zones. A yearly
  event can carry a wall-clock `time`, read in the viewer's zone. Also
  `recurrence` (`none` / `yearly`), `year_known` (yearly dates without a known
  year use the placeholder year 2000, a leap year, so 29 February works; in
  non-leap years it falls on 28 February), and `remind_days_before`. A
  person's birthday field is a shortcut that creates/updates a yearly
  `birthday` event with `person_id` set, so Coming up, reminders and the
  morning briefing all read one table.
- **`edges`** — typed relationships between any two entities (`note`,
  `person`, `project`, `place`, `organisation`, `event`, and since 0018 a
  `record` in one of the owner's own types). This is the
  Obsidian-style graph, but richer than file-based backlinks: relation types
  aren't limited to "links to", and the graph is queryable with recursive
  CTEs directly in SQL. `origin` says where a link came from: `content`
  (derived from a note body) or `manual` (created explicitly).
- **`push_subscriptions`** / **`reminder_log`** — Web Push endpoints for the
  installed PWA, and an idempotency log so a reminder is never sent twice.
  Each subscription records a `credential`, a fingerprint of the token or
  key that registered it (migration `0057`); endpoints are accepted only on
  known push services, at most 10 are kept, and one whose credential no
  longer works is deleted before the next send (`SECURITY.md` §8).
- **`custom_fields`** / **`custom_values`** — the owner's own fields on any
  kind of record ("Shoe size" on people, "Rating" on Watch & read) and
  their values, one per field per record. See "Your own fields" below.
- **`custom_kinds`** / **`custom_records`**: the owner's own kinds of
  record ("Wines", "Plants", "Board games"), called **types** in the app,
  and the records kept in each. A type's fields live in `custom_fields`
  under the kind `custom:<uuid>`. See "Your own types" below.
- **`ask_threads`** — Ask's conversations, one row each: the owner's name
  for it, the whole conversation as one JSON array, `archived_at`, and
  `updated_at` (the device's time, newest wins) / `synced_at` (the server's,
  for pulls). See "Ask's conversations" below.
- **`files`**, **`note_files`**, **`thread_files`** — photos, screenshots,
  PDFs and Markdown/text added in Ask or to a note. The row says what a file
  is (sealed name, type, size, pixels, pages), plus Claude's sealed
  `summary` and a PDF's or text file's sealed `extracted_text`, written on
  its first read; the bytes are in Netlify
  Blobs, sealed. A file is kept while a note or a conversation links to it.
  See "Files" below.
- **`reminders`** — custom reminders the owner asked for: free text,
  `remind_at` (the instant it next fires), `repeat` (`none`, `daily`,
  `weekdays`, `weekly`, `monthly`, `yearly`), `anchor_day` (the day of month
  it was set for), an optional `about_type`/`about_id`, and `done_at`. Not an
  archivable entity: a reminder is finished (`done_at`), not archived.
- **`connectors`**, **`collections`**, **`collection_runs`**,
  **`collected_items`** — accounts Athena signs in to and what it collects
  from them; see "Connectors" below.

Every table except `metrics`, `note_chunks` and `sensitive_blobs` has an
`archived_at` column. Archived rows are hidden from every read path — lists,
search, Home, Ask, counts, upcoming/reminders, the briefing, MCP, backlinks,
the Obsidian export — except the app's Archived page, where they can be
restored or permanently deleted (see `SECURITY.md` §7).

### Links between things

There is one link syntax everywhere — app editor, MCP, agents, export:

```
[@Priya Shah](athena://person/<uuid>)     person
[@Dishoom](athena://place/<uuid>)         place
[@Netlify](athena://organisation/<uuid>)  organisation
[@Mum's birthday](athena://event/<uuid>)  event
[@Château Musar](athena://record/<uuid>)  a record in one of your own types
[Q3 planning](athena://note/<uuid>)       another note
[@Green dress](athena://saved/<uuid>)     something in Saved
[@Book the dentist](athena://todo/<uuid>) a to-do
[@Perfect Days](athena://watch/<uuid>)    a Watch & read title
```

`saved`, `todo` and `watch` links aren't graph entities: they open their item
(Saved's page, the to-do or Watch & read sheet), the graph draws them when the
item is in it (a to-do, a reading item), and content-link sync and the
export leave them as their label.

**@ mentions in Ask.** Ask's composer (`components/mention-input.ts`, a
contenteditable line) suggests anything on `@`: `GET /api/mentions?q=&recent=`
(`lib/mentions-db.ts`) reads people, places, organisations, events, projects,
notes, records, saved items, to-dos and Watch & read titles, opens their
sealed titles in the Function and ranks them in memory (`lib/mentions.ts`:
match quality, then recency, recent picks first, five a kind, twelve in all).
Sample mode and offline rank this device's copies the same way. The list is
the same component as the note editor's (`components/mention-menu.ts`); on a
phone it docks above the composer as a sheet. A pick is a chip; the message
is sent with its athena:// links. Before the model runs, the assistant and
the answer path resolve each mention into a `<mentioned>` block (kind, id,
title, key fields, a saved item's link) and are told to act on exactly those
ids. Mentions show as chips in the sent message and in the assistant's reply.

It's ordinary Markdown link syntax, so note bodies stay plain Markdown
(keyword search, agents and the Obsidian export keep working) and the visible
label is still searchable. A link may carry how it's shown in its title
(`"card"`, `"embed"`; see "Rich links in notes"). `lib/links.ts` is the one
parser, shared by the server and the PWA. Whenever a note is created or its body changes,
`syncContentLinks` makes that note's `origin='content'` edges (relation
`mentions`) exactly match the links in its body; manual edges are never
touched by that sync. Backlinks ("notes mentioning this") are just incoming
edges, read by `getConnectionsDetailed`, with archived items on the other end
filtered out. The export rewrites these links to `[[wikilinks]]`.
- **`metrics`** — a time-series table (metric name, value, timestamp,
  metadata) for anything trackable over time: meeting load, issue throughput,
  finance trend points, habit counts.
- **`note_chunks`** — chunked note text plus a native `vector` column via the
  `pgvector` extension (confirmed supported on Netlify DB), with an HNSW
  cosine-distance index for fast semantic search directly in SQL
  (`ORDER BY embedding <=> $1 LIMIT 10`).
- **`sensitive_blobs`** — the home for health, location, money, home and
  finance figures, sealed under the data key like everything else. See
  `SECURITY.md` §1 for the full model; in short, `ciphertext` is where that
  data lives at rest, and `label` is deliberately kept non-sensitive so
  rows are browsable without opening anything.

### Why Netlify DB over alternatives

The project already runs on Netlify, and Netlify DB removes an entire category
of operational concerns: no separate hosting account, no separate connection
secret to provision outside Netlify's own environment-variable injection, and
(per the cost note above) no reason to economize on a smaller or
self-hosted Postgres. It's also the vendor's own documented, supported
integration with Netlify Functions, which matters because it sidesteps a real
open question: **as of the last check, Netlify's own documentation did not
confirm whether the Netlify DB connection string is reachable from outside
Netlify's runtime at all.** Rather than build the whole system on an
assumption that might be false, every normal read/write path goes through
`lib/db.ts`, which calls `@netlify/database`'s `getDatabase()` — the
officially documented access pattern *from inside* a Netlify Function. That
sidesteps the unknown entirely instead of depending on its answer.

The one deliberate exception is the Obsidian export script
(`scripts/export-obsidian.ts`), which runs as a plain Node script outside the
Functions runtime and therefore cannot use `getDatabase()`. For that one case,
Netlify documents a second, explicit pattern meant for exactly this situation:
`getConnectionString()` paired with an external Postgres client (`pg`). See
`SECURITY.md` for why that's safe here and nowhere else.

### Encryption at rest

Your content — note titles, bodies and tags, people's details, events,
reminders, to-dos, catch-ups, facts, the review inbox, life admin, reading
and goals — is stored encrypted (AES-256-GCM under `ATHENA_DATA_KEY`, a
production-only secret). The data layer does it: writes seal text through
`sealer()` in `lib/db.ts`, and `q()` opens every sealed value in a result,
so the API, MCP, the briefing and the collector see plaintext and nothing
above `lib/` changed. SQL can't compare or sort ciphertext, so name sorting,
keyword and `@`-mention search and recall happen in the Function, and exact
lookups on people (resolve_person, attendee matching) use HMAC blind
indexes. Ids, dates, kinds, statuses, `source` and the `edges` graph stay
readable. A scheduled function, `encrypt-data`, seals existing rows in the
background; previews, which have no key, show "Encrypted — open on
athena.example.com" and refuse to save text. Full detail, including what's
left readable and how to rotate the key, is `SECURITY.md` §11.

### Why pgvector

Semantic search ("what did I write about X") needs nearest-neighbor search
over embeddings. Running it as a Postgres extension alongside the structured
data means no second vector database to provision, sync, or keep consistent
with the source of truth — a chunk's embedding lives right next to the note it
came from, in the same transaction boundary, queried with the same SQL the
rest of the system already uses. pgvector's HNSW index makes the cosine-distance
query (`<=>`) fast enough for this scale without any extra infrastructure.

## The gateway: Athena MCP Server

One Netlify Function (`netlify/functions/mcp.ts`, with shared tool
implementations in `netlify/lib/mcp/`) speaks the MCP protocol over Streamable
HTTP — Netlify's documented pattern for hosting a remote MCP server — behind
bearer auth: the master token, a full key, or a Claude only key (scope
`mcp`, prefix `athm_`), which works here and on no `/api/*` path
(`SECURITY.md` §5). Its tools:

- Notes: `create_note`, `get_note`, `update_note` (title, body, type, source,
  tags), `list_notes`, `search_notes`, `capture`.
- People, places, organisations, events, projects: `upsert_person` (including
  birthday, organisation, catch-up cadence), `upsert_place`,
  `upsert_organisation`, `upsert_event`, `upsert_project`, and `get_*` /
  `list_*` for each.
- The PA views and the graph: `list_upcoming`, `search_entities` (to find ids
  for athena:// links), `get_connections` (outgoing + backlinks), `link`,
  `unlink`.
- Trips and purchases (read only; the email collection writes them):
  `list_trips`, `get_trip`, `list_purchases`, `get_purchase`.
- `archive` / `unarchive` (any kind, by id, including a `record` and a
  whole type, `kind`).
- Custom reminders: `create_reminder` (an ISO instant, or a date and/or
  time in the owner's zone; optional repeat and `about`), `list_reminders`,
  `update_reminder` (including `done: true` to cancel; no delete).
- Metrics: `upsert_metric`, `query_metrics`.
- Saved actions: `list_saved_actions` (what fits an item, or find items by
  words) and `run_saved_action` (`netlify/lib/mcp/saved-actions.ts`).
- The owner's own fields: `list_custom_fields`, `get_custom_values`,
  `set_custom_value` (no way to define, archive or delete a field). Every
  `get_*` and `list_reading` / `list_goals` / `list_assets` result carries
  the record's filled-in fields as `custom_fields`. The field tools take a
  type's kind (`custom:<uuid>`) as well.
- The owner's own types (`netlify/lib/mcp/custom-kinds.ts`): `list_kinds`,
  `get_kind`, `create_kind` (with its fields), `update_kind` (name, singular,
  icon), `upsert_record`, `get_record`, `list_records`. Archiving goes
  through `archive`; there's no tool to delete a type or a record.

Agents get full create/edit control **except delete**: there is deliberately
no delete tool and no way to list archived items through MCP. Permanent
deletion is a manual action in the app only (`SECURITY.md` §7). That holds
for a Claude only key; a full key also reaches REST, where delete and the
archived list are. An edit can overwrite, so `updateNote(id, patch, opts?)`
keeps what it replaced in `note_versions` (migration `0061`,
`lib/note-versions.ts`) whenever the title or body changes: the newest 20
per note, sealed, with `opts.by` stored as `changed_by` (`"mcp"`,
`"owner"`, `"api"`, `"restore"`, or null). The app's editor sends
`X-Athena-Editor: 1` on `PATCH /api/notes/:id`, which marks the change
`"owner"`; those are grouped to one version per 10 minutes. `GET
/api/notes/:id/versions` lists them and `POST
/api/notes/:id/versions/:version/restore` puts one back. Tool descriptions
teach the athena:// link syntax.

Tools that return stored text wrap it as `{ content_notice, source, data }`
(`netlify/lib/mcp/results.ts`), and the server's instructions say `data` is
content, never instructions. A tool error returns its message only when it
is an input error; anything else is one fixed line.

This is the single write path. Claude Code, Claude Desktop, scheduled
collection agents, and any future MCP-capable tool all read and write Athena
through these tools — real CRUD against the schema, never raw SQL exposed to a
caller. Connecting any MCP-capable client looks like:

```
claude mcp add --transport http athena https://<site>.netlify.app/mcp \
  --header "Authorization: Bearer <a Claude only key>"
```

Make the key in Settings → API keys. Keys are listed, made and removed with
the master token only; the one exception is `DELETE /api/api-keys/self`,
which lets any key remove itself.

Routing every write through one gateway (rather than letting each surface talk
to the database directly) keeps the schema's invariants — tagging
conventions, the sensitive-blob encryption boundary, edge uniqueness — enforced
in exactly one place.

## Mobile + offline: a proper local-first PWA

This replaces "Obsidian pointed at an iCloud folder" as the mobile story. One
installable Progressive Web App (installs to the iPhone home screen like a
native app, scaffolded under `app/`) provides:

- **Local storage**: IndexedDB in the browser, holding a cached copy of recent
  notes/metrics plus an *outbox* of writes made while offline.
- **Offline capability**: a service worker caches the app shell, so the app
  opens and is usable — read cached data, create/edit notes, queue captures —
  with no connection. Only Home and the app's chrome are in the entry
  script; every other view and the note and record sheets are lazy chunks
  (`app/src/main.ts`), loaded on first visit and in the background once Home
  has painted. The service worker caches every chunk of a build (following
  each script's chunk references) and only switches its offline copy of the
  page to a new deploy once that deploy's chunks are all cached. Sample
  mode keeps its notes in an offline database of its own (`athena-sample`).
- **Signing in and out**: the app signs in with a full key made for that
  device. The master token is pasted once on Connect, sent in one `POST
  /api/api-keys`, and not kept (`signIn` and `swapMasterForKey` in
  `app/src/db/api.ts`). Sign out (`app/src/db/sign-out.ts`) drops the push
  subscription, removes the device's key on the server, clears
  `localStorage` and `sessionStorage`, deletes both offline databases and
  every `athena-*` cache, and unregisters the worker, warning first when
  changes haven't been sent. The worker leaves `/logout` alone, so the page
  Sign out lands on isn't cached. Detail in `SECURITY.md` §5 and §6.
- **Sync**: on reconnect/app-open, the outbox flushes to the same Netlify
  Function API the dashboard and MCP server use (`lib/db.ts` underneath); a
  pull fetches anything changed elsewhere since the last sync (a simple
  `updated_since` timestamp query — correct for a single-writer personal
  system).
- **Conflict policy**: last-writer-wins by timestamp. No CRDT library, no
  third-party sync engine. PowerSync and ElectricSQL were both considered and
  both expect a direct replication connection to Postgres, which runs into the
  same undocumented-external-access question above — and both are built to
  solve multi-writer conflict resolution at scale, a problem this system
  doesn't have. A hand-rolled outbox-and-reconcile is simpler, adds no new
  vendor dependency, and is the right amount of engineering for one person's
  data.
- **Known caveat, stated plainly**: iOS Safari has historically not supported
  the Web Background Sync API the way Android/Chrome does, so "sync happens
  automatically the moment connectivity returns, even in the background" is
  not a safe assumption on iPhone. The app is designed for
  **sync-on-open/foreground** instead, which is reliable everywhere; true
  background sync is a bonus if the current iOS Safari turns out to support
  it, not something relied upon.
- The app has three views and one always-available action, in one codebase:
  **Home** (a sentence summary of the day, the latest note, weekly metric
  charts, people to catch up with, recent notes, and sources), **Notes**
  (search plus a filter by `source` — e.g. one tap to see only
  `email-digest-personal` — grouped by day; a reading pane beside the list on
  desktop, a bottom sheet on mobile), and **Ask** (a chat-style surface: a
  question gets a written answer with sources from Athena and the connected
  accounts, an instruction such as "add the Lego Ferrari to Rowan's
  Christmas gift ideas" is carried out, and a message can be both; all of it
  is one assistant, `lib/answer.ts` below. Offline it's an honest keyword
  match across notes, people and to-dos). **New note** is
  a sheet reachable from anywhere (the + button, the sidebar, or `C`). The
  visual system — Funnel Display + Geist, OKLCH tokens tinted toward cobalt,
  light-first with a system-driven dark mode — is documented in
  `.impeccable.md` and `app/src/styles/tokens.css`.

### The Library: people, places, organisations, events

The dock's Notes tab is now **Library**, with a segmented control (Notes,
People, Places, Orgs, Events, and so on, then one section for each of the
owner's own types before Graph); the desktop sidebar lists the same sections,
plus **Archived** at its foot (mobile reaches Archived from the header
status menu). The sections sit in small groups (Notes and collections,
People and places, Home and money, Health and habits, then the owner's own
types, then More), defined once in `app/src/lib/library-layout.ts`; the
index, the sidebar, ⌘K and a phone's segmented row all read it, and a phone
only offers the sections of the group you're in. Each section is a list plus a profile — a sheet on mobile, a
pane on desktop (`app/src/views/records.ts`,
`app/src/components/record-profile.ts`). Profiles edit in place: a person's
birthday (with age, or "year unknown"), relationship, organisation (a
`works_at` link, created on the fly), email and phone, catch-up cadence and
last spoke; a place's address with Open in Maps; an event's date, time,
yearly repeat and reminder days. Each shows related things and **Notes
mentioning this** (backlinks).

Record edits need a connection (`app/src/db/records.ts`): they're small,
rarely made on the go, and some fan out server-side (a birthday writes an
event). Offline, profiles read from the device cache and saving says so.
Sample mode keeps its edits on the device.

Home gains **Coming up**, which shows this week (today and the next six
days) of birthdays and events from `/api/upcoming?tz=<device zone>`, plus
anyone overdue a catch-up by their own cadence. Offline, it's computed on
the device from cached records. It's sized to how busy the week is: a quiet
week lists everything; a busy one keeps the dates you added one per row,
folds each day's calendar events into one row, and ends with "+N more this
week" after six rows. Home also pins **today's briefing** note when the
reminders function has written one.

### The Graph

The Library's last section, **Graph** (`#/graph`, or `#/graph/<id>` with
something selected), draws everything and its links as a force-directed map
on a `<canvas>`, Obsidian-style. Nodes are live notes, people, places,
organisations and events, plus the layer-2 details that hang off them:
catch-ups, to-dos (not dropped), current facts and reading recommendations,
and records in the owner's own types (one colour for all of them, with a
filter chip per type; a record in an archived type isn't drawn).
A detail is only a node when something live is on its other end. Links come
from `edges` (both origins), `interaction_people`, `commitments.person_id`, a
fact's subject, `reading_items.recommended_by` and `events.person_id`, one
per pair, never touching anything archived.

- **Server**: `GET /api/graph` is one query in `lib/graph.ts` (kept out of
  `lib/db.ts`), returning `{ nodes: [{ id, kind, title, sub, at, degree }],
  links: [{ source, target, relation }] }`.
- **App**: the page (`app/src/views/graph.ts`), the renderer
  (`app/src/graph/`, `d3-force` ticked by its own frame loop) and
  `styles/graph.css` are a lazy chunk, so the main bundle barely grows.
  Chips by kind filter it and double as the legend; search jumps to
  something; a switch hides notes with no links. Tap a dot to light it and
  its neighbours up, tap again or use the card to open it through the app's
  own handlers. Pinch, drag and wheel to move around; drag a dot to pin it.
  With reduced motion the layout settles before it's drawn. **List** shows
  the same graph as text for screen readers.
- **Data**: `app/src/db/graph.ts` follows the usual degrade chain: the API,
  then the last copy it returned, then a graph built on the device by the
  same rules (the only source in sample mode). Unsynced notes are laid over
  the server's copy with their body links.
- **Local graphs**: people, places, organisations, events and notes end with
  a small graph of their neighbours (with "Two steps out" for depth 2),
  `app/src/components/local-graph.ts`. Its renderer loads when the section
  nears the screen and lays out before drawing, so it costs a phone little.

### Time zones

All instants are stored in UTC: notes, runs, and timed events'
`starts_at`. The app shows them in the browser's time zone. The server needs
a zone for the decisions it makes on its own, namely "today", due and
overdue to-dos, the weekly review's week, the 07:30 briefing, when custom
reminders fire, push text, the assistant's clock, and collections' "daily
at" times. For those it uses `settings.timezone` (`getOwnerTimeZone()`, read
once per request or run), which the app updates whenever the device's zone
changes, so they follow you when you travel. It defaults to Europe/London
until a device reports one. The app works out its own "today" in the
device's zone (`app/src/lib/time.ts`) and sends that zone with the times it
saves (events, reminders) and with `/upcoming` and `/review/week`. Calendar
dates (birthdays, all-day events, due dates) have no zone and are never
converted. `lib/dates.ts` has the zone-aware helpers (`zonedToday`,
`zonedToInstant`, `localWhen`, `upcomingOccurrences(…, tz)`); migration
`0009_utc-times` converted existing London-local times.

### Reminders and the briefing

`netlify/functions/reminders.ts` is a Netlify Scheduled Function on a
5-minute UTC cron. The briefing, timed-event pushes and the Sunday review
nudge follow the owner's time zone (`settings.timezone`, see "Time zones"),
so clock changes and travel need no cron changes. So do custom reminders
and layer 2's dates (due, overdue, renewals, the weekly review).

- From 07:30 local, once per day, it writes the briefing note (type `daily`,
  source `briefing`) and pushes a digest linking to it. The note covers
  today's events, the next week, today's meeting notes from the
  `calendar-meetings` agent, overdue catch-ups and yesterday's captures. Its
  athena:// links make it show up in those people's backlinks.
- Timed events get one push 30 minutes before they start. Birthdays and
  all-day events appear in the 07:30 digest on each `remind_days_before` day.
- The wording and scheduling are pure functions (`lib/briefing.ts`). Sending
  lives in `lib/push.ts` (`web-push`, VAPID from env, pruning 404/410
  subscriptions). `reminder_log` makes each send happen exactly once.
- Custom reminders (`reminders` table, maths in `lib/reminders.ts`): each
  run sends every pending reminder whose `remind_at` has passed, guarded by a
  `reminder:<id>:<remind_at>` key, then marks a one-off done or moves a
  repeating one to its next occurrence after now (missed ones are skipped,
  not sent in a burst). Repeats keep their wall-clock time in the owner's
  zone, and when that zone changes, pending repeats move to the same time
  of day in the new one (`alignReminders`; `settings.reminder_timezone`
  records the zone they're lined up with, Europe/London when missing).
  One-offs are fixed moments, like timed events. Monthly and yearly ones
  clamp to short months and return to `anchor_day`. The
  push opens the linked item, or the Reminders page. The briefing lists the
  rest of today's reminders. The PWA's Reminders page has a composer (text,
  quick times, day, time, repeat) and the pending list (mark done with Undo,
  delete); it needs a connection to change them and shows the last list
  read-only offline.
- The PWA's Reminders page subscribes the device with `pushManager.subscribe`
  from a tap (iOS 16.4+ with Athena on the Home Screen) and explains plainly
  when push isn't available. The service worker shows notifications and
  focuses or opens the app at the deep link.

### Check-ins

A morning preparation and an evening reflection: a few questions, one to a
screen. The contract (types, the question library, the routes) is
`lib/checkin-types.ts`.

- **Tables.** Migration `0075_checkins`: `checkins`, one row per (date,
  kind). The day's plan and its answers are sealed together in `sealed`
  (the column requires `enc:v1:`, so nothing is written without
  `ATHENA_DATA_KEY`); `status` (open, done) and `done_at` stay readable for
  ranges and streaks. The table is in `ENCRYPTED` for key rotation. The
  set-up (both routines, own questions) is the plain `settings` row
  `checkins`; own question text is readable there, and sealed once it's in a
  day's plan.
- **Plan and rotation** (`lib/checkin-plan.ts`, `planFor`). Pinned questions
  come first, in list order, all of them even past `per_day`. The rest fill
  `per_day`, least recently asked in the last 60 days first; a tie goes to
  the one asked longer ago before that, then list order, which gives an even
  turn. `GET /api/checkins/:date/:kind` plans today, or tomorrow for
  time-zone slack, the first time it's read (insert-if-absent, so two
  devices agree) and keeps it. A routine that's off, or a past day nobody
  opened, gives an empty plan and stores nothing.
- **Mirrors.** Recomputed from both of the day's check-ins on every answer
  and undo, so repeats change nothing. `day_mood`: the latest mood answer
  becomes the day's mood, and the owner's own mood comes back on undo unless
  they've set one since. `day_journal`: one section per check-in ("Morning
  preparation", "Evening reflection"), swapped by exact text, never touching
  the owner's words; if the owner edited Athena's section, a fresh one goes
  at the end. `health_energy`, `health_stress`, `health_mood_labels`: Health
  source `athena_checkin` ("Check-ins").
- **Routes** (`netlify/lib/checkins/routes.ts`, from `api.ts`): settings GET
  and PUT, a range of statuses (no key needed), a day's check-in, PUT and
  DELETE an answer, POST done (keeps the first time), POST deeper (one
  follow-up question from `lib/checkin-deeper.ts`, a 12-second budget,
  `{ question: null }` on any failure, nothing saved). MCP
  `athena_get_checkin` and `athena_list_checkins` read without planning.
  Live kind `checkin`.
- **The app.** `components/checkin-flow.ts` (one question to a screen,
  answers saved as given, queued in `checkin-outbox` offline),
  `checkin-entry.ts` on Today (a card per routine that's on, side by side,
  at any hour, with what's left or done), `checkin-day.ts` on the day page,
  `checkin-settings.ts` (Settings → Check-ins; needs a connection).
  `db/checkins.ts` caches settings and each check-in in `meta`.
- **Pushes** (`lib/checkin-push.ts`, `reminders.ts` sections 4 and 4a). The
  morning push (`morning`, `morning_at`, default 07:00) goes out once a day
  (`morning:<day>`), at or after `morning_at` any time that day, outside
  quiet hours, while the morning routine is on and today's check-in isn't
  done. With the evening routine on, the evening push becomes "Evening
  reflection" and opens `/#/checkin/evening`; only a finished reflection
  skips it. With it off, the evening prompt is as before.
- **Briefing.** `lib/briefing-run.ts` reads today's morning check-in
  (`loadCheckin`, never plans) and passes answers to questions whose mirror
  is `briefing` to the writer as `morning_checkin` ("Focus: Work, Family",
  "You said a good day would be: …"); never-nudge topics are filtered out.
  A check-in finished after the briefing has run changes nothing.

### The live channel

While the app is open and visible it holds one Server-Sent Events stream,
`GET /api/live/events` (Netlify Server, `netlify/server/routes/live.ts`),
read with `fetch` and the app's bearer token. Writes happen in functions, so
the server learns of them from the database: while at least one stream is
open, `netlify/server/live/` reads a watermark (newest timestamp and row
count) per watched table every 3 seconds and sends `change` events naming
the kind and the changed ids, never content. `app/src/live/` then runs the
pulls the app already has (notes, records, to-dos, trips, Saved, Ask chats,
nudges, Sources). It closes the stream when the app is hidden, so the
server can stop, and reconnects with backoff. The pulls on opening and on
coming back to the app remain the fallback. Notes: `docs/netlify-server-live.md`.

### Athena speaks first (proactive nudges)

`lib/proactive/` is a small rules layer the reminders function runs every
5 minutes. Each rule is a pure function from a snapshot of the owner's data
(`ProactiveInput`, built by `lib/proactive/load.ts`) to zero or more nudges
(`rules.ts`):

- **Meeting prep**, 15 minutes before a meeting with people: the last
  meeting/call catch-up, notes linked to the event or its people, email and
  message catch-ups from the last fortnight, and open to-dos with them. For
  those meetings the bare 30-minute push is skipped, but only when prep will
  speak (on, not muted, prep time in working hours, room under the cap;
  `prepWillSpeak`). Otherwise the meeting keeps its 30-minute push.
- **After a meeting**, in the hour after it ends: "How did the call with
  Priya go?" Ask turns the answer into to-dos, a note or a draft. Nothing is
  sent.
- **Awaiting reply**: a sent email whose latest message is still the
  owner's, asking something, unanswered for N working days (Settings, 3 by
  default). Newsletters, automated senders, mail sent before the mailbox was
  connected, and threads the owner dismissed are skipped. Sent mail is read
  through each mailbox's own `search_threads` (`netlify/lib/proactive/mail.ts`),
  at most once an hour and only in working hours.
- **Leave by**: the next event today at a Place, within 90 minutes. Travel
  time comes from a live planner when one is set up
  (`netlify/lib/proactive/directions.ts`): TfL's Journey Planner when both
  ends are in London, Google's Routes API elsewhere (transit then walking),
  by the owner's way of travelling (below, "Leave by's ways of travelling").
  Their keys are Sources accounts (below, "Live travel keys"). Either way it's
  arriving by the start, from where the owner has been today to the Place's
  spot. A TfL answer is cached for 10 minutes; Google, which is billed, is
  asked once per event and kept until it starts; a drive is asked once more
  when its leave time is 30 to 15 minutes away (`recheckDue`), before the
  nudge is made, so the nudge has the rechecked time. Without either, it's a
  distance estimate (`lib/proactive/travel.ts`) that also reads the
  briefing's TfL commute check (`loadCommute`): a disrupted usual line adds
  10 minutes. "Why am I seeing this?" names the source, or says it's an
  estimate and links to Sources at Places and travel
  (`#/settings/sources?add=travel`), as Settings → Notifications does when
  no planner is set up.
- **Day plan by energy**, 07:30 to 11:00 after a short night (the briefing's
  own `shortNightUnder` line) or recovery 15+ under the median: moves for
  the morning's long solo blocks to a free slot after 13:00, through
  `/api/scheduling/move` with the receipt's Undo. It rides in the morning
  briefing (`lib/proactive/briefing.ts`, `DeliverDeps.dayPlan`): the note
  gets a "lighter plan" section listing the moves, the push adds "A lighter
  plan for today is on Home.", and the nudge has no push of its own. The
  proactive pass runs before the briefing so both land in the same run.
- **Weekly plan**, Sunday 18:00 to 22:00: undated to-dos placed on next
  week's lightest working days, each part applied on its own (and put back).
- **Your routines** and **Something to watch tonight**: see "Plans, routines
  and What Ask did". Routines are on (the owner made them); watch tonight is off.
- **MOT and car tax** (`car`, on): about 30 days and again 7 days before a
  car's MOT or tax date (`carDue`), from the daily car sync (below, "The
  car"). A renewed date is a new key and the old card is closed.
- **Drift**: a habit missed on the same weekday at least three weeks running,
  checked once a day in the first half hour of the working day. A workout
  logged in Health that day means an exercise habit wasn't skipped. The
  calendar names a likely clash (the same event on the missed days), and the
  habit's own line from Patterns goes in the evidence.

`gate.ts` applies what every nudge shares: the rule's switch (meeting prep
and awaiting reply on by default), a 30-day "Fewer like this" mute, quiet
hours, a daily cap (4) and dedupe by key. Work nudges only come inside the
working hours from Settings → Days; the rest keep out of notification quiet
hours (or 22:00 to 07:00). An item added after it happened (a backfill) never
gets one. Nudges are kept in `nudges` (migration 0051, payload sealed), mutes
in `nudge_mutes`, switches in the `settings` row `proactive`.

A push links to `#/ask/nudge/<id>`. The app loads the nudge and calls
the app-wide `openAsk({ context, prompt })` (`app/src/lib/open-ask.ts`) through `app/src/lib/ask-nudge.ts`, with the nudge's meeting or person as the context chip: Ask starts a new
conversation with the nudge's context above it and the suggested first reply
in the box. Home shows live nudges under "For you"
(`components/nudge-card.ts`), each with "Why am I seeing this?" (the
evidence) and "Fewer like this". `/api/nudges` serves the cards, a nudge,
dismiss, applied parts, mutes and prefs.

### What's in motion (layer 2)

Migration `0005_pa-memory` and `lib/memory.ts` add what a PA actually works
from: what's open, who you spoke to, and the small things worth remembering.
Every read hides archived rows except the Archived page; MCP still has no
delete tool.

- **Commitments** (`commitments`), shown in the app as **To do**: `todo`,
  `i_owe` (a to-do *for* someone, "For Priya"), `waiting_on` (someone owes
  you) and `decision` (a record, stored as done). Marking done stamps
  `done_at`; reopening clears it. With a `source_ref`, an agent re-filing the
  same title from the same source gets the existing row back. Each to-do
  can carry an area and a where/how (`todo_contexts`, migration 0037). The
  owner edits them in Settings → To do. Any to-do Athena files itself gets
  them in `upsertCommitment`, through `chooseContext` in
  `lib/todo-context.ts`, which goes in order: the owner's last correction
  for that sender, a work account, words, a personal account, then the
  model's guess when it's sure. Anything unclear stays blank.
  Since migration 0084 a to-do also has details (`lib/todo-details.ts`):
  `notes` is its description in Markdown (the note editor, so @ links work),
  `steps` its checklist and `links` its web pages and athena:// links, each
  list one sealed JSON value written whole, and `priority` (0 none to 3
  high), which orders open to-dos due on the same day. `cleanSteps` and
  `cleanLinks` are the one set of rules for the server, sample mode and the
  MCP tool. Athena links in the description or the links become the
  to-do's content edges (`syncContentLinks(id, linkableText(c),
  "commitment")`), so the graph and a person's Related chips show them; a
  to-do deleted for good takes its edges with it. The app opens a to-do in
  `components/commitment-sheet.ts`: a check and title, a row of property
  pills (`todo-props.ts`: due date with a month calendar, person, priority,
  area, where), the description, steps (`todo-steps.ts`) and links
  (`todo-links.ts`).
  Athena adds details too, under one rule for what a step is
  (`STEPS_RULE` in `lib/todo-details.ts`): the parts of one to-do that the
  source spells out, never a meeting's separate actions. Ask's `add_todo`
  takes a description, steps, links and a priority, and `change_todo` adds,
  ticks, reopens and removes steps by the ids `find_todos` returns, with
  Undo. Team assistants and flows run the same tools. A collection's
  `athena_todo` takes `steps`, and the runner keeps them only as a list of the to-do's own parts
  (`filedSteps`: two to twelve, none that restate the title, none on a
  decision); one below the confidence bar waits in Review with its steps.
- **Interactions** (`interactions` + `interaction_people`): every catch-up,
  by channel. Logging one moves each person's `last_contacted_at` forward
  (never back), which is what clears them from catch-up nudges. Same
  `source_ref` = update, not duplicate.
- **Facts** (`facts`): one current value per subject + key (people, places,
  organisations, or the owner as `me`); a new value supersedes the old one,
  which stays as history.
- **The owner's profile** (`lib/profile.ts`): `me` facts under known keys
  (`PROFILE_FIELDS`, four wizard steps), the rest shown as "Other". Only the
  owner writes them directly (the app, Ask's remember, `PUT /api/profile`);
  `addFact` files any other `me` fact as a suggestion, at any confidence,
  and accepting it saves it. `profilePromptBlock()` (current values, under
  1,500 characters) goes at the end of the Ask and answer system prompts;
  the briefing follows "Briefing length" and "Never nudge about". Wizard
  progress is `settings.profile_setup`.
- **The profile learner** (`lib/profile-learner.ts`, weekly function
  `profile-learner`): plain rules over calendar, workouts, sleep, habits,
  places, Days entries and Watch & read file at most five `me` suggestions a
  week (source `profile-learner`, evidence in `source_quote`). It skips keys
  the owner rejected in the last 3 months, typed in the last 90 days or
  already has waiting, and values Athena already has. One small model call a
  week sums up liked titles as genres. Runs in the background function
  `profile-learner-run`.
- **Identities** (`identities`): extra emails, phones, Slack handles and
  aliases, normalised, so `resolve_person` can match an agent's "priya@acme"
  or "@priya" to one person. `mergePeople` folds a duplicate into the keeper
  in one transaction (links, note bodies' athena:// links, interactions,
  commitments, facts, identities, dates) and archives the duplicate.
- **Suggestions** (`suggestions`), the **Review inbox**: what an agent found at
  confidence below 0.8. Accepting applies the payload through the same db
  function the matching MCP tool uses; rejecting keeps the row so it's never
  re-filed.
- **Life admin** (`assets`), **Watch & read** (`reading_items`: books, films,
  TV shows, articles, videos, podcasts, music, games; migration `0014`
  widened the kinds; the month card's genre radar, this month against the
  last, counts every genre a watched film or show has, TV's paired genres
  split, `lib/watch-stats.ts` `mix`) and **goals**
  (`goals`): renewals and expiries feed Coming up and the briefing; never
  store ID, policy or account numbers in an asset.
- **Music** (`#/music`, Library → Notes and collections, after Watch &
  read): what the owner played, read from Days' `listened` entries (not
  archived, not folded; Overcast and Audible left out) through `GET
  /api/life/music?period=month|year|all|YYYY` (`lib/music-data.ts`). No
  store, no migration. An entry is an album (or artist) on a day: title =
  album, subtitle and group = artist, plays = `count`, else 1. Artist and
  album are sealed per row with a random IV, so SQL filters, computes plays
  and caps the rows (150,000, newest first; the page says when older ones
  drop off); grouping by name happens once they're opened, and rows before
  the period fetch only the artist. The rules are pure (`lib/music.ts`), so
  sample mode (`db/sample-music.ts`, two years over about 40 invented
  artists) draws the same page. Per period: plays with a chip against the
  same span before (last month to the same day, last year to the same date,
  the year before), top 10 artists as ranked bars wearing their most played
  cover, top albums as a cover grid (Apple Music's rows are tracks: kept out,
  and shown as Top tracks only when a period has no albums), a timeline (days
  for a month with the rest as empty slots, months for a year, years past
  three years of months) with one takeaway line,
  artists first played in the period, and the last 20 days with music, each
  linking to its Day. `?artist=<name>` gives one artist over everything held
  for the sheet (plays over time, top albums, first and last played, Ask).
  When you listen: a day-of-week × hour heatmap (House's `heatmap` with
  24 slots) and one takeaway, from `day_entries.hours` (migration 0062: 24
  plays per local hour as sealed JSON text, `lib/day-hours.ts`). The Last.fm
  and ListenBrainz history loads fold each play's hour beside the count; the
  Life log run sends `hours` on `athena_day_entry`. Loading history again
  updates hours on rows it wrote (same id, same count) and, on days a run
  wrote under its own ids, fills them by album and artist
  (`fillEntryHours`): never a new row or a new count. Periods without timed
  plays say so instead of an empty grid.
  Playlists (not tied to the period): Spotify's, read by Athena's own sync
  (`netlify/lib/connectors/playlist-sync.ts`) in each Life log run and on
  Load history again, kept sealed in one settings row
  (`lib/playlist-store.ts`, `settings.music_playlists`, no migration). Only
  playlists the owner made or collaborates on have tracks (Spotify's rule
  since February 2026); an unchanged snapshot id isn't read again. A sign-in
  from before the playlist scopes gets "Sign in again" on the page and the
  account, never an account error. Covers are made from the name (no
  image fetched from Spotify). `GET /api/life/music?playlists=1` lists them,
  `?playlist=<id>` gives one with its tracks.
  Covers: plays whose source sent none (Spotify's history download, Apple
  Music's export, Last.fm albums without an image) get their album's from
  Deezer by name (`lib/art.ts` `album` hint, last after the source's own
  image and a Spotify link; a track's album for Apple Music's rows). An
  artist none of whose plays has one wears their best-known album's, and a
  track's cover stands in when no album has one. Music applies what's
  already kept on each load (`cachedArt`, one query) and asks for the 30
  most played still missing after the reply, so covers fill in over a few
  visits; Days' entries get them through the usual art backfill.
  Genres: a radar of the period's genre mix against the span before
  (`lib/genre-mix.ts`, House's `radarChart`). Each artist's genres are
  looked up after the reply (`netlify/lib/music-genres.ts`, at most 12
  artists and 8 seconds a load, most played first): Spotify's artist search
  when a Spotify account is connected, then MusicBrainz's (no key, one
  request a second). Kept as the source gave them, sealed in one settings
  row (`lib/music-genre-store.ts`, `settings.music_genres`, no migration);
  an artist neither knew is asked again after a month. On read they're
  folded into about fifteen families ("uk alternative hip hop" is Hip hop),
  two at most an artist, weighed by place (sources list the strongest
  first), so the folding can change without asking again. Shares are of
  plays whose artist has a genre; the card says how much that covers and
  how many artists are still being looked up.
  Spotify's Extended streaming history (privacy download) imports beside
  Apple Music (`lib/spotify-history.ts`, `components/spotify-history-import.ts`,
  `POST /api/days/import/spotify_history`): plays over 30 seconds, no
  podcasts or audiobooks, one listened entry per album a local day with
  count, minutes and hours, id `albumDayId` (`lib/day-imports.ts`, the same
  the Last.fm and ListenBrainz loads use, for any album-and-day writer).
  Albums Last.fm has that day are left to it; a day a Life log run wrote
  for Spotify keeps its entries and only gains hours (`fillEntryHours`).
  The period is kept per device. Ask's `taste` tool takes `from`/`to` for
  "who did I play most this year?".
- **House** (`#/house`, Library → Home and money, first, beside Money and Life admin): the home's
  energy, its cost, household bills and house admin, from `GET
  /api/life/house` (`lib/house-data.ts`, same access as Money). The figures
  are pure (`lib/house.ts`, `lib/tariff.ts`), so sample mode draws the same
  page. Energy is the sealed `home` days (moved off Money, which keeps
  spending only): half hours against a usual day, a week heatmap, 30 days
  of both fuels, months with year on year, baseload and peak share, each
  with a one-line takeaway; charts are inline SVG (`house-charts.ts`).
  Costs need the Octopus account number, kept as `?account=` on the
  meters' address (no migration): the meter sync then reads the
  agreements and their public prices once a day (`readOctopusTariffs`) into
  one sealed `home` row with source `tariff` (`lib/tariff-store.ts`), and
  each day is priced half hour by half hour with its standing charge.
  Meter history goes back 24 months (or to the first empty month): on
  connect, Edit and **Load history again** through the history engine
  (`backfill.ts`, `octopusBackfill`), and as many months as fit in each
  Life log run (`money-sync.ts`); prices are read 25 months back
  (`TARIFF_HISTORY_DAYS`) to match `HOUSE_DAYS`.
  The Home collection (below) reads the meter every hour, so a day shows
  up soon after Octopus has its readings, with no model involved.
  Bills are the regular payments (`lib/recurring.ts`) whose payee is a
  household bill; house admin is Life admin filtered (`isHouseItem`).
  Trends (after By month, `lib/house-trends.ts` pure, drawn by
  `components/trends-charts.ts`): one card with a fuel switch and four
  views kept per device (This month: the forecast bar and month on month;
  Last year: same month last year and year to date as paired bars; 12
  months: the 24-month line; Weather, gas only: gas against temperature
  with the fitted line). A view without the data says when it will show;
  "Show figures" holds its table. The figures: per fuel and per
  day, this month so far against last month and the same month last year,
  the last 12 months against the 12 before and the year so far against the
  same dates last year (only when the readings cover both, otherwise how
  many months they need, so the page reads 25 months), and a month-end
  forecast at the month's daily rate with recent days weighted up to twice
  (not in the first 3 days). £ only when every day of both periods was
  priced. Gas is also shown allowing for the weather: heating degree days
  (base 15.5°C) from Open-Meteo's daily mean at the Home Place
  (`lib/weather.ts` `dailyMeans`, cached by month; `homeSpot` in
  `lib/house-data.ts`: the Home place's visit spot, else its address
  through `placeStop`), a least-squares line of gas against them from at
  least 60 days with a spread of weather, and each period's gas against
  what the line expects. No Home, too little history or no answer within
  6 s: raw figures and one line saying why. Ask reads the same through the
  `energy` read tool.
- **Recall**: ranked full-text search (English stemming, web-search
  syntax) across notes, commitments, interactions, facts, people and
  watch & read. The text is encrypted at rest, so recall reads the live rows,
  decrypts them and ranks them in the Function (`lib/text-search.ts`);
  migration `0012` dropped the old Postgres full-text index. Ask's answers
  search with it, and its offline keyword search runs its keywords through
  recall for "Also in Athena".
- **A follow-up acts on the reply before it** (owner, 12 Nov 2026). The app
  sends the conversation so far with every message
  (`app/src/lib/ask-history.ts`: each of Athena's turns whole, up to 6,000
  characters, general answers included). The prompt says "this", "that"
  and "it" mean the reply just before. "Turn this into a recipe" keeps the
  recipe that reply gave with `save_recipe` (`lib/assistant-recipes.ts`:
  title, ingredient lines and steps, with Undo), which needs no link.
  Related items are left out under a general answer: a keyword match on
  the question's words isn't related to it. While `lib/ai.ts` waits out a
  gateway refusal (up to a minute) the loop sends a busy step
  (`lib/ask-busy.ts`, the same id the app's own retry uses) and takes it
  away when the reply starts. When a reply lands, the app keeps it clear
  of the composer and the tab bar (`clearBars` in `views/ask.ts`).
- **Ask is one assistant** (owner, 12 Nov 2026). Every message goes to one
  model loop, `runAsk` in `lib/answer.ts`, through one route,
  `POST /api/assistant { question, history?, files?, earlier?, skill?,
  thread_id? }`. Nothing in front of it decides whether a message is a
  question or an instruction: the loop holds the read tools,
  `search_athena`, the connected accounts (`SourcesPort`), web search and
  the write tools, and the model uses what the message needs. The first
  search is the exception: a request ("Remind me tomorrow to call Sam",
  `isRequest`) gets none, and no past chats in the prompt, because the
  model looks up what it needs. "What did
  Gayle say about pricing, and add a to-do to follow up" is one run and one
  reply: the text in the answer shape with checked, numbered citations and
  `general`, and, when it changed something, `changes` (receipts with
  Undo), `choices`, `scheduling`, `confirm` and `plan`. A plain question
  costs what it did before: one model call when the first search or the
  model's own knowledge answers it. What may run is decided by a guard in
  code (`lib/ask-guard.ts`, `SECURITY.md` §10): only the owner's own words
  ask for a change; after a turn has read an account's item, a web page or
  a file, a change those words didn't plainly ask for waits as a plan; a
  flagged result takes the write tools and web search away for the rest of
  the turn. The two bullets below describe its two halves: the write side
  and the answer.
- **Ask's write side** (`lib/assistant.ts`, a `Session` held by the loop;
  entered through the Netlify Server in `netlify/server/`, which applies
  the rate limit in code; see `docs/netlify-server.md`). On the server a streamed
  reply is a *run* (`netlify/server/assistant/runs.ts`,
  `docs/netlify-server-ask.md`): the app names it (`X-Ask-Run`), it runs
  under `waitUntil` whether or not the app is listening, and its steps and
  reply are kept in memory and as a sealed record in Netlify Blobs. The
  same request sent again, or `GET /api/assistant/runs/<id>`, follows it;
  it never runs twice. The loop reads first and makes its one change last,
  and the run's record says a change is coming, and is written, before it
  is made (`beforeChange`): a run lost while reading is safe to start
  again, and one lost after that never is. The app reconnects that way after a dropped stream
  or a spell in the background (`app/src/lib/ask-run.ts`), and sends a try
  that lost its connection again under the same id. A streamed error
  carries `retry_after` in seconds when the gateway said how long to wait
  (`lib/steps.ts`), and the app's reader follows it. The server also
  keeps connected accounts open between answers (`warm-sources.ts`) and
  gets ready when Ask opens (`POST /api/assistant/warm`). Claude via
  Netlify AI Gateway (`lib/ai.ts`; Sonnet 5.5 unless
  `ATHENA_ANSWER_MODEL` says otherwise; `ATHENA_ASSISTANT_MODEL` now only
  sets a Shortcut capture's model) with Athena's tools: find people
  (by name, email, email domain, phone, relationship, organisation or one of
  the owner's fields), notes, to-dos and everything else (`find_items`); add
  a person (only once the owner has said to); add to a checklist note,
  creating "<Name> · <list>" linked to the person when it doesn't exist;
  write notes; add, change or tick off to-dos; set and change reminders;
  remember details; log catch-ups; change people, one or many at once
  (`update_people`); add or change places, organisations, events, goals,
  life admin and projects, rename a trip or mark a purchase delivered
  (`save_item`); add or change trips, bookings and orders with their
  tracking (`save_trip`, `save_booking`, `save_purchase`); link and unlink records (`link_records`); archive and
  restore anything (`archive_or_restore`); the owner's own fields and types
  (`lib/assistant-fields.ts`, `lib/assistant-kinds.ts`); and `ask_owner`,
  which ends the turn with choices the app shows as buttons. The tools that
  change things are strict (`""` and `[]` mean "leave it"). Each change
  comes back with an undo (`POST /api/assistant/undo`) that archives what
  was created, restores what was changed, or restores what was archived; a
  change to many records is one undo. Nothing deletes. The app sends every
  message to the one route; the router that used to sit in front
  (`routeByRule`, Jev's `/api/assistant/route`, `hand_off`,
  `claimsReadOnly`) is gone, and so is the regex that read a message as an
  instruction: sample mode, which has no server, plays its made-up replies
  from each sample's own trigger and otherwise shows the keyword search. Three tools reach a
  connected account (`answer_invite`, `draft_message` / `draft_email`,
  `send_note`) and only prepare a card: the reply carries `confirm`
  (`ConfirmCard[]`, `lib/assistant-confirm.ts`) beside `scheduling`, the app
  draws each under the reply (`components/ask-confirm.ts`), and the RSVP,
  the saved draft or the doc happens on the owner's tap, through the
  existing routes. A Shortcut capture (`POST /api/assistant/capture`) gets
  five filing tools only (`CAPTURE_TOOLS`: `save_note`, `add_todo`,
  `add_reminder`, `add_to_list`, `add_to_watch_read`), no ports, and a
  fixed reply (`SECURITY.md` §5). It has a small loop of its own
  (`runCapture`): it reads nothing, so it shares nothing with Ask's.
- **Ask's answers** (`lib/answer.ts`, the same loop and route): Ask
  answers like a personal assistant (owner, 12 Nov 2026). "What did Gayle
  say about pricing last month?" is answered from everything, with sources;
  "how long does a passport renewal take?" from what the model knows or the
  web, labelled; and each at the length the question needs. Claude (Sonnet
  5.5 unless `ATHENA_ANSWER_MODEL` says otherwise) gets Athena's own read
  tools (`search_athena`: recall plus
  the note search; `read_note`; `find_people`; `person_details`: details,
  catch-ups, to-dos both ways, decisions, notes mentioning them) and each
  connected account's allowed read tools, live: Granola's
  `search_meetings`, `get_meetings`, `search_transcripts`,
  `get_meeting_transcript`; Gmail's `search_threads`, `get_thread`;
  Calendar's and Slack's searches; others' allowed tools, up to 8. The
  accounts come through a port (`SourcesPort` in `lib/answer.ts`,
  implemented by `netlify/lib/connectors/answer-sources.ts` over the MCP
  client), like `lib/drafts.ts`'s `MailPort`. It finishes with an `answer`
  tool: text with `[1]` markers and the sources they cite, each an Athena
  ref (`note:`, `person:`, `todo:`), a link a tool returned, or a page the
  web search returned. The server keeps only sources that a tool really
  returned in that run (Granola meetings get their `notes.granola.ai/d/<id>`
  link from their id) and renumbers the markers. It also says what it
  searched ("Searched your notes, 2 calls and Gmail", "… and the web"),
  which accounts it couldn't, and up to three uncited matches for "Related
  in Athena".
  - *General answers.* When Athena and the accounts don't hold the answer
    but the model knows it (a fact, advice, a sum, a draft), it answers and
    the reply carries `general: true`: nothing of the owner's is behind it
    (no source of theirs, no file, not their day). The app labels it. A
    claim about the owner's own life still needs a source: the prompt says
    so, and an answer the model calls not general that names no source at
    all is still "I couldn't find anything about that." An answer whose
    named sources don't survive checking keeps its text without their
    markers and is marked `general`. An answer that rests on the owner's
    data, with or without a general part beside it, is not general.
  - *Web search* (Anthropic's server tool `web_search_20250305`; "Let Ask
    search the web", `GET/PUT /api/profile/ask-web { on }`, `lib/profile.ts`,
    on by default). While the switch is on the tool is offered, for what the
    owner's data can't answer and the model doesn't reliably know; three
    searches an answer, counted across model calls. The search runs on
    Anthropic's side inside the model call and its results come back in the
    same response; a page is cited by its link as a source of kind `web`
    (`url`, the page's `title`, no id or account), checked like any other
    link, and never saved to Athena. Each search is a step with its words
    ("Searched the web for …"). The prompt forbids anything from the owner's
    data in a query; the tool is taken away for the rest of an answer once
    something read looks like an instruction (before the model sees it) or
    a query holds an email address or a person the tools named. A provider
    that refuses the tool is asked again without it (the `rejectedTool`
    path) and isn't offered it until the server restarts. While the switch
    is off the tool isn't sent at all, and an answer that needed it links
    to the switch (`setting`).
  - *Shape* (`answerProse` in `lib/answer-text.ts`). Short is the default:
    one to three sentences. A list, summary, plan, comparison or draft may
    run to 6,000 characters. The text has three shapes and nothing else:
    paragraphs split by a blank line, list lines, and `**bold**`. A list
    line starts `- `, or a number (`1. `) for steps in order (owner, 12 Nov
    2026). A list is one block, all dashes or all numbers, and a step keeps
    the number the model gave it, so steps split by a note or by dashes
    carry on from the last number. Whatever else the model writes is turned into those (a
    heading becomes a bold line, a starred item a `- ` line, `2)` becomes
    `2. `) or dropped, and text past the limit is cut at a line or sentence
    with "…". Talk and one-line previews use `stripCitations`, which also
    takes the dashes and bold off; a step keeps its number.
  - *Follow-ups* (`parseAnswerHistory`). `history` is the last 12 turns,
    each `{ role, text, refs? }`; `refs` is what that reply cited, up to 8
    Athena refs or https links. The model is told what each earlier reply
    cited so it can read it again. That isn't evidence: a citation still
    needs a tool to return it in this run.
  - *Speed and limits* (`limits()`). In a function, aiming at 15–25
    seconds: at most 6 model calls and 14 lookups, effort low, and past 18 s
    the model is told to answer with what it has. On the Netlify Server,
    where no function limit applies: 10 model calls, 24 lookups, effort
    medium, and the wrap-up comes at about 60 s. A routine's answer gets
    the server's figures too (`long`), inside its background function.
    When AI Gateway's minute is used up the route answers 429, with
    `Retry-After` in seconds when the gateway gave a wait (not on a
    streamed reply, whose error is an event). Either way the accounts
    open in parallel (6 s cap) while a first Athena search for the
    question's words runs and goes into the first message; lookups run in
    parallel, 9 s each; an account that fails is skipped and named.

  The app
  (`app/src/components/ask-answer.ts`) shows "Searching your notes, calls
  and email…", then the prose with numbered citations and a chip per source
  (call, email, event, message, note, person, to-do: title and day); a
  citation or chip opens the note, person or to-do in the app, or the call
  or email in its own account. Offline, or when the endpoint fails, a
  first message in a new chat shows the keyword search instead and says
  why. A follow-up never does (owner, 12 Nov 2026): with Athena's turns
  before it, its words mean nothing to a keyword search, so the message is
  kept, the reply's place says Athena's AI couldn't be reached, it's asked
  again by itself once after 8 s (busy or out of reach; offline waits for
  the connection), and then offers Try again
  (`app/src/lib/ask-fallback.ts` `afterFailure`). Sample mode has a few
  canned answers. Talk speaks the text without its numbers.
- **Ask, live and steerable** (`lib/ask-stream.ts`, `app/src/lib/ask-*.ts`,
  `app/src/lib/open-ask.ts`). On the same NDJSON stream as the steps, the
  reply's words arrive as `{type:"text", delta}` lines: the answer's are
  read from the `answer` tool's partial JSON and sent in the shape the
  finished text will have (`answerProseSoFar`: a heading, an open bold or a
  bare list marker waits until it's whole), the assistant's from its text,
  and `{type:"text", reset:true}` takes back words a tool call follows. The
  finished `done` reply (with checked, renumbered citations) always replaces
  them. Follow-ups come in the same model call: a `next` field on the answer
  tool, a `<next>…</next>` line after the assistant's reply, cleaned to two
  or three short ones. Stop aborts the fetch, and the server stops the
  model's stream too. Edit (↑ in the empty box) replaces your last message
  and its reply; Try again keeps earlier versions (`versions`, `version`) and
  pins (`pinned_at`) inside the reply's own message in `ask_threads`, so no
  schema change. `openAsk({ context, prompt })` is the one way in from
  elsewhere: the context shows as a chip and goes as an @ mention. ⌘J opens
  Ask and Esc goes back; ⌘K stays "Search or jump to…", which now offers
  "Ask about “…”" for what was typed.
- **What both back ends share** (`lib/ask-tools.ts`, `lib/ask-context.ts`,
  `lib/ask-threads.ts`). The assistant and the written answer used to see
  different data. Now three things are the same for both:
  - *One set of read tools* (`READ_TOOLS`, run by `ReadTools`): `goals`,
    `trips` (with bookings), `purchases`, `habits`, `days` (a day in full
    with its journal, mood, health line, places, weather and spending; a
    range; or a search), `health` (figures by day, averages, and the span
    before for trends), `places` (stops by day, filterable by name),
    `patterns`, `money` (card payments and direct debits by merchant,
    category, dates and amount, with exact totals and optional grouping by
    merchant, category, month or day), `energy` (House's Trends, through
    `houseEnergyData`) and `regular_payments`. Each reads
    through the lib function the app's own page uses (`listGoals`,
    `listTrips`, `listPurchases`, `habitDays`, `getDay`/`searchDays`/
    `entriesInRange`, `healthDays`, `placeDays`, `getPatterns`,
    `readMoneyDays`, `regularPaymentLines`), with no SQL of its own, and
    every record comes back with a ref made by the caller's `cite`. `money`
    and `regular_payments` are offered only while "Let Ask read
    transactions" (Settings → About you, `GET/PUT /api/profile/ask-money`,
    off by default) is on; `ReadTools` refuses them otherwise, and the
    reply to a spending question is "Money search is off" with a link to the
    switch: the model sets `needs_money` and the fixed line replaces its words
    (no word rule in front of the loop decides it). The
    answer cites them (`day:`, `goal:`, `trip:`, `purchase:`, checked like
    the rest; the app opens a goal, trip or order in its sheet); the
    assistant gets the same results to answer or act on. The old keyword
    gates (`isHealthQuestion`, `isPlacesQuestion`, `isMoodQuestion`,
    `isMoneyQuestion`) no longer decide what Ask may read: the model picks
    the tool. Search snippets and note reads still leave a Life log note's
    Health and Places sections out.
  - *Today's context* (`askContext`): a block of at most 2,400 characters
    (about 600 tokens) added to every turn's system prompt after the fixed
    instructions: now and the zone, today's and tomorrow's agenda, last
    night's sleep and readiness, to-dos due and open, reminders today,
    travel today and the trip under way, stored weather and the last place
    seen. Built at most once a minute per zone, through Jev's check, and
    each part that fails is left out. The answer tool's `from_today` lets a
    question the block answers ("am I free after lunch?") come back without
    a lookup, footed "From your day in Athena". Any other answer with no
    source is a general one (above), or refused when it claims to be about
    the owner's own life.
  - *Cross-chat memory* (`pastThreads`): a chat's first turn, and a later
    one that brings a new topic or names someone new (`bringsNewTopic`),
    gets up to three short summaries of past chats that share its topic
    words or the people it @-mentions (rarer words count more, a name
    counts double, recency only breaks ties; nothing shared, no memory).
    The chat being asked in is left out.
- **What Athena knows** (`lib/knows.ts`, `GET /api/profile/knows`;
  `app/src/components/knows-page.ts` at `#/settings/knows`, one step in from
  About you): the owner's `me` facts, details about people they told Ask to
  remember (`source = 'assistant'`) and `me` suggestions waiting in Review,
  grouped by the app (`app/src/lib/knows.ts`) into Remembered in Ask, From
  your profile, Learned from your activity and Waiting for you. Changes go
  through the routes that own each thing (`PUT /api/profile`,
  `/api/facts/:id`, `/api/suggestions/:id`). In a reply, a remembered detail
  shows as one line, "Remembered · Undo", instead of a receipt row.
- **Jev** (`lib/jev.ts`, TypeSafe's typed-answer model via AI Gateway,
  `@typesafe-ai/sdk`): small decisions around Claude, each falling back to
  the old behaviour when Jev is off or fails.
  - `netlify/lib/connectors/precheck.ts` glances at each account before a
    scheduled run (Granola `list_meetings` updated since the last good run,
    Gmail `search_threads`). It skips Claude when there's nothing new, and
    sorts new email by where it belongs (action, receipt, date, renewal,
    alert, reference, noise) in one batched `choice` call. Only noise is
    dropped; noise Jev isn't sure of goes to its next likeliest kind, and
    wording that reads like an order, booking, alert, renewal or date is
    read as that whatever Jev said. Claude is told which tool each goes to.
  - `guardText` flags tool results and note text that look like they're
    instructing an AI.
  - `calibrated` sets the confidence of the collector's to-dos and details.
- **Derived reads**: `personBrief` (facts, identities, interactions, open
  loops both ways, decisions, recommendations), `loadToday`, `weeklyReview`
  and `listRenewals`.

Everything an agent writes carries provenance (`source`, `source_ref`,
`source_quote`, `confidence`), and the app shows it where it matters: a
to-do's sheet and each review card quote the words it came from.

In the app (`app/src/db/memory.ts`, same degrade chain as records): **To
do** (grouped by due date, quick add, decisions), the **Review inbox**
(buttons, swipe, or A/R), **This week** (one-sentence summary, done,
decisions, people seen, still open, catch-ups, next week, goals), **Life
admin**, **Watch & read** and **Goals**. Home gains a To do card, review and
weekly-review banners, renewals in Coming up and what's due in its headline.
A person's profile gains an in-place catch-up log, their to-dos, things to
remember, a timeline merging catch-ups with mentions, also-known-as and
Merge a duplicate.

The reminders function adds: to-dos due, renewals, quiet waiting-ons (5+
days) and the review inbox to the morning briefing; who a meeting is with,
when you last spoke and what's open between you to the 30-minute push; and a
Sunday 18:00 weekly-review push. The collection-agent specs say how to
extract all of this (see `.claude/agents/`).

### Trips and purchases, from email

Migration `0015_trips-purchases` and `lib/trips.ts` turn booking and order
emails into records Athena can act on, rather than notes. The wording
(briefing lines, "Arriving today", trip dates) lives in `lib/trip-text.ts`,
which the server and the PWA share.

- **Trips** (`trips` + `trip_bookings`): a flight, train, hotel stay, car
  hire or event ticket is a booking; bookings group into a trip named after
  where it's to ("Lisbon, 12–15 Mar"). A new booking joins a live trip to the
  same place within three days of its dates, else one whose dates overlap and
  that shares a city (the flight home leaves from where you stayed), else the
  only overlapping trip; otherwise it starts a trip. A trip's dates follow its
  live bookings. Instants are UTC (`starts_at`, `ends_at`) and each end keeps
  its place's IANA zone and city, so times show in the place's own time with
  the city named; "today" is the owner's (`settings.timezone`).
- **Updates, not duplicates.** A booking is matched by its reference (blind
  index), then by segment ("outbound"/"return") or, without one, a start
  within a day. A moved time marks it changed and keeps `previous_starts_at`;
  a cancellation marks it cancelled. Fields an update leaves out keep what's
  there. Saves return the other bookings under the same reference, so the
  collector can name one by id.
- **Purchases** (`purchases` + `purchase_updates`): retailer, item names,
  order number and date, carrier, tracking number and link, expected day and
  a timeline. Later emails for the same order number (at a compatible
  retailer), or the same tracking number, move it on: ordered, dispatched,
  out for delivery, delivered, delayed, returned, refunded, cancelled. An
  email older than the current status only joins the timeline. No price,
  total or card column exists (finance is its own tier, `SECURITY.md` §1),
  and the collector refuses text carrying an amount. Settled ones are archived
  by Athena 30 days on (`archived_by_athena`); a later email brings one back,
  and one you restore stays (`stay_visible`).
- **Collecting.** The email digest (and custom collections) get
  `athena_trip_booking` and `athena_purchase` (and, since 15 Nov 2026,
  `athena_email_date` for appointments and deadlines, `athena_renewal` for
  Life admin and `athena_alert` for account alerts, below); below 0.8 confidence they file
  `booking` / `purchase` suggestions for the Review inbox. Precheck keeps
  transactional email (orders, bookings, delivery updates) as receipts even
  when Jev calls it noise, and tells Claude which tools they're for. Run
  stats count bookings and orders, new and updated.
- **Where it shows.** Home's Coming up lists each trip's next booking this
  week and parcels arriving or out for delivery (a small chunk loaded after
  the first paint). The 07:30 briefing gains Travel and Deliveries ("Flight
  BA 432 to Lisbon tomorrow 07:10 from Heathrow T5, ref ABC123"). Timed
  bookings (not hotels) get a push in the place's own time, with the seat
  and reference: a flight 3 hours before, the rest 30 minutes before
  (`BOOKING_PUSH_LEAD_MINUTES` in `lib/trip-text.ts`). The Library gains **Trips** (upcoming, then past;
  a trip's itinerary day by day) and **Purchases** (on the way, then
  delivered; a four-step tracker, Track, Email, It arrived), both lazy views.
- **Your own.** New in Trips and Purchases (`app/src/views/trip-forms.ts`)
  adds a trip (a place and dates), its bookings (local times; the zone
  follows the city) and orders with tracking; Ask does the same with
  `save_trip`, `save_booking` and `save_purchase`, from words, a booking PDF
  or an order screenshot. They're `source: "manual"`. An email about one
  only adds to it (lib/trips.ts `saveBooking`, `savePurchase`): a booking
  with the same reference gains what it's missing (seat, terminal, details,
  the email, the end time); an order gains status steps forward, carrier
  and tracking, never a new shop, items, number or days. Adding one an
  email already brought in merges into it. Fields you edit on any booking
  or order are listed in `owner_edited` (0020), and later emails skip them
  (a status you set can still move forward). A cancellation email always
  comes through: the booking or order is marked cancelled and says which
  email did it (`cancelled_at`, `cancel_email_link`; an order's dated
  step); every other field stays. Orders you added are never
  archived automatically. A manual trip keeps its dates, stretched to hold
  its bookings (`refreshTripDates`). Track opens the email's link, else
  one built from the carrier and number (`lib/carriers.ts`, tested).
- **API and MCP.** `/api/trips[/:id]` (POST; PATCH name, notes, a manual
  trip's dates), `/api/bookings[/:id]` (POST into a trip; PATCH any field),
  `/api/purchases[/:id]` (POST; PATCH status or any field), with archive and
  unarchive; MCP `list_trips`, `get_trip`, `list_purchases`, `get_purchase`,
  and `archive` for the new kinds. No delete tool.

### What email keeps

The email digest surfaces what matters, not every email (owner, 15 Nov 2026;
notes in `docs/notes/email-signal.md`). A note is for reference mail only:
in an email digest run (`AthenaWriter.referenceNoteOnly`) a new note tagged
`fyi`, `receipt` or `action-item`, a `capture`, or a sixth new note is
refused with where it goes instead; saving one item from Ask isn't limited.
Everything else is a record: orders and bookings (above), to-dos,
`athena_email_date` (an `events` row, kind `appointment` with a push before
it, or `deadline` with reminders 3 days and on the day; matched per thread,
joined to a calendar twin, archived when an email cancels it, past dates
refused), `athena_renewal` (an `assets` row: matched by name, else the only
one of its kind with that provider; a date only moves forward; an archived
one stays archived; no long numbers) and `athena_alert` (a to-do due today,
one per thread, and a push outside quiet hours). Each sets off a Team event
(`kind` delivery, booking, appointment, deadline, renewal, alert or todo,
with `email: true`), and a purchase or booking fires once per status.

**Travelling today** (`lib/travel-day.ts`, `app/src/components/travel-today.ts`): on
a day with bookings, Home (above Today) and the day page lead with the day's
legs in time order, each with a live chip, platform or gate, and its
reference. Live times come from `GET /api/travel/live`
(`netlify/lib/travel-day-routes.ts`) every 2½ minutes while a leg is in its
window and the app is in front, otherwise nothing is asked. Trains use
National Rail (`netlify/lib/live-travel.ts`); flights use OpenSky with no key
(`netlify/lib/live-flights.ts`, behind a `FlightProvider` interface so
another provider can be added). The same flight status goes on the Trips
card, into the push 3 hours before, the briefing and Ask's
`flight_status`. No migration.

**Live travel keys** (`lib/presets/live-travel.ts`): Google Maps (routes),
TfL and National Rail are Sources accounts in Places and travel, each with
a pasted key and no tools or recipe, like OpenSky. `travelKey(kind)`
(`netlify/lib/travel-key.ts`) is the one place that reads them: the stored,
sealed key first, then the old environment variable, then nothing.
`directions.ts` and `live-travel.ts` call it; `liveTravelReady()` is the
async check, and `liveTravelConfigured()` stays synchronous for Ask, which
reads the stored keys first (`primeTravelKeys` in `/api/assistant`).
"Check connection" is `live-travel-direct.ts`: one small read-only call per
service. No migration: token accounts already seal their key.

**The car** (`lib/car.ts`, `lib/car-sync.ts`, `lib/car-store.ts`,
`netlify/lib/car-api.ts`, `netlify/lib/car-routes.ts`; notes in
`docs/notes/car.md`). DVLA (Vehicle Enquiry, one key) and DVSA MOT history
(API key, client ID, secret and token URL: the preset's `clientCredentials`)
are Sources accounts in Places and travel (`lib/presets/car.ts`), checked
by `connectors/car-direct.ts`. Either is enough. The owner adds
registrations on either account's page (`components/car-vehicles.ts`); the
whole car state is one sealed `settings` row, `car`. The reminders function
reads each vehicle once a day (`runCarSync`) and keeps two Life admin items
in step per car, "Ford Focus MOT" and "Ford Focus tax" (kind `vehicle`),
remembering their ids so there's never a second one; a moved date updates
the item and closes its nudges, SORN or removing the car archives it. The
`car` rule speaks about 30 and 7 days before either date. Life admin shows
a card per car (`components/car-card.ts`): status in words, the last test,
miles a year and the latest test's advisories in plain words. Ask reads it
with `car_details`. `/api/car` (GET, POST and DELETE `vehicles`, POST
`refresh`). No migration.

**Leave by's ways of travelling**: `travel_mode` (Settings → Notifications,
"How you usually travel") and `travel_by_event` (an event's "Getting there",
`components/getting-there.ts`) in the proactive prefs. `plannerFor`
(`lib/proactive/travel.ts`) picks TfL or Google; a drive is Google's
traffic-aware DRIVE only, and without a key the nudge has no time and says
how to add one.

### Your own fields

The owner adds their own details to any kind of record in **Settings**
(`#/settings`, `app/src/views/settings.ts`): "Shoe size" (a number, in UK
sizes) and "Interests" (choices) on people, "Rating" (one to five stars) on
Watch & read. Types: text, long text, number with an optional unit,
rating, yes/no, date, link, choice (one of a list) and choices (several,
like tags; new ones join the list as they're used). Fields have an order
the owner sets, can be renamed, and are archived, never deleted: an
archived field waits on the Archived page with its values. A type change is
only allowed when every value survives it (text to long text, choice to
choices, rating to number…, `SAFE_TYPE_CHANGES`); otherwise the editor says
to make a new field.

- **Kinds.** `FIELD_KINDS` in `lib/custom-field-rules.ts` lists them (people,
  places, organisations, events, notes, reading, goals, life admin,
  projects) with each one's table: one line adds a kind. The tables store a
  kind string, not a fixed list, so the owner's own types
  (`custom:<uuid>`, below) reuse the same definitions, values, Settings list
  (`renderSettings`), field editor (`openFieldEditor(kind)`) and record
  editor (`customFieldsSection(kind)`). `isFieldKind` and `fieldKindInfo`
  answer for them from a registry the server and the app fill in
  (`registerCustomKinds`).
- **Storage.** `custom_fields` (kind, label, type, options, unit, position)
  and `custom_values` (field, record, value as JSON text), migration `0016`.
  Labels, units, options and values are sealed (SECURITY.md §11), so names
  are matched and values searched in the Function (`lib/custom-fields.ts`).
  Permanently deleting a record deletes its values in the same statement as
  its edges; merging people fills the keeper's empty fields.
- **In the app.** Every record's Details card ends with its kind's fields in
  the same label-and-value rows (`app/src/components/custom-fields.ts`):
  tappable stars, Yes/No and choice chips, tags with type-to-add for
  choices, inputs for the rest. They save as they change. A saved record
  shows only the fields with a value; the empty ones wait behind one row,
  "Add shoe size and interests" (`addFieldsPrompt`), that opens them. A
  field edited while the record is open stays put until it's closed. A new
  record shows every field and saves what was typed once it exists
  (`show(id)`, or `commit(id)` for sheets that close on create). A note's values
  save like the note: on the device first, through the outbox
  (`queueFieldValue` in `app/src/db/sync.ts`); everything else needs a
  connection, as the profile does. Sample mode has its own fields.
- **Search.** The Library lists' filters and recall (Ask's "Also in
  Athena") match text and choices values.
- **Ask** (`lib/assistant-fields.ts`): `find_items`, `list_fields`,
  `add_field` and `set_field`. "Rowan's shoe size is 6", "rate Dune 5
  stars", "Priya is into climbing and jazz". It asks before inventing a
  field, and every change comes back with Open and Undo.
- **MCP** reads fields and values and sets values (above); the Obsidian
  export puts each record's fields in its frontmatter.

### Your own types

Beyond the built-in kinds, the owner makes their own kinds of record,
called **types** in the app: Wines, Plants, Board games. Each has its own
fields and its own records. The word "types" and every phrase built on it
live in one copy module, `lib/custom-kind-words.ts`; in code they're
"custom kinds" and "custom records".

- **Storage** (migration `0018`). `custom_kinds`: name and singular
  (`one`, "wine") sealed, `icon` (a name from `KIND_ICONS`) and `position`
  readable, `archived_at`. `custom_records`: `kind_id`, title and Markdown
  body sealed, `archived_at`; deleting a type deletes its records
  (`ON DELETE CASCADE`). A type's fields and values are ordinary
  `custom_fields` / `custom_values` rows under the kind `custom:<uuid>`.
  Names are sealed, so uniqueness is checked in the Function under an
  advisory lock, matching case-insensitively and singular against plural
  (`labelKey`): "Wines" and "wine" clash, archived ones included. Names are
  at most 40 characters, there are at most 50 live types, and a name that
  sounds like a bank, card, password or medical detail is refused
  (`sensitiveLabel`), since §1 content never goes in a type.
- **Server.** `lib/custom-kinds.ts` holds every read and write: list, find
  (by id, key or name), create with fields in one transaction, rename
  (a singular that was worked out from the old name follows it), reorder,
  duplicate, and records' create, update, duplicate, detail and search.
  Values are given by field name and checked before anything is written.
  REST is `/api/kinds` and `/api/records`
  (`netlify/lib/custom-kinds-routes.ts`).
- **Duplicate.** A type becomes "Wines copy" with its live fields and no
  records, and opens so the owner can rename it. A record becomes
  "Château Musar copy" with its notes and values (and so the links in its
  notes).
- **Archive.** Archiving a type hides it, its records and its fields
  everywhere (Library, search, @, recall, Graph, Ask, MCP) and keeps them;
  restoring brings everything back. A record archives on its own too.
  Permanent delete is on the Archived page only, and its confirm says how
  many records go with a type.
- **In the app.** Each type is a Library section at `#/kind/<id>`
  (`app/src/views/custom-records.ts`): a filter over titles, notes and
  text and choice values; rows subtitled with the first one or two filled
  fields; a pane on desktop and a sheet on a phone
  (`app/src/components/custom-record-profile.ts`) with the title, Details
  (the type's fields, as on any record), Notes (the TipTap editor,
  `@` links included), Linked, Mentioned in and a local graph; Duplicate
  and Archive in its menu. Settings › Your types
  (`#/settings/types`, `app/src/components/kinds-settings.ts`) makes,
  renames, reorders, duplicates and archives them, with an icon picker;
  each type also gets a tab in Settings › Your fields. Data is
  `app/src/db/custom-kinds.ts` with the usual degrade chain; edits need a
  connection, like the other records. Sample mode has Wines (Grape,
  Region, Rating, Price in £) with four bottles, one mentioned from a
  sample note.
- **Ask** (`lib/assistant-kinds.ts`): `list_kinds`, `make_kind` (with
  fields), `find_records`, `save_record`, `duplicate_kind` and
  `update_kind` (rename, singular, icon), each with Open and Undo; fields
  are changed with `change_field` and types and records archived with
  `archive_or_restore` (`lib/assistant-records.ts`). "Track my wines" or
  "make a Wines type" makes a type; a shopping list or a checklist is still
  a note or a to-do. Answers can cite a record (`records_of` in
  `lib/answer.ts`), and recall searches records.
- **MCP** has the tools listed above, and still no delete.
- **Export.** The Obsidian export writes each live type to
  `types/<type>/`, one file per record with its fields in the frontmatter.

### Person suggestions on to-dos

`lib/todo-person.ts`, `lib/todo-people.ts`, `netlify/lib/todo-people-routes.ts`.
An open to-do with nobody linked whose title names someone gets "Link to …"
in To do and in its sheet. `GET /api/todo-people` returns
`{ suggestions: { <to-do id>: [{ id, name }] } }`, up to three people each;
`POST /api/todo-people/:id/dismiss` stops it for that to-do. Linking is the
to-do's own PATCH. Matching is whole-word on names, first names and aliases,
done in the Function; nothing about a match is stored, and there is no
migration. It exists because a capture key files only and can't look a
person up (SECURITY.md §5).

### Editing notes

The note view (mobile sheet / desktop pane, `app/src/components/note-detail.ts`)
is the editor. It's TipTap (ProseMirror) in WYSIWYG mode with Markdown as the
storage format via `@tiptap/markdown`, so `notes.body` stays plain Markdown.
The editor is a lazy chunk (`app/src/editor/`, loaded with `import()`), so
Home stays light; the service worker precaches it by following the entry
script's chunk references, so editing works offline from the first install.

- `@` suggests people, places, organisations and events (`/api/entities/search`,
  falling back to entities cached on the device) and, online, offers to
  create a new one; `[[` suggests notes. Both insert the custom `athenaLink`
  node, which reads and writes `[@Name](athena://kind/<uuid>)` through
  TipTap's `markdownTokenizer` / `parseMarkdown` / `renderMarkdown` hooks;
  its tokenizer runs before marked's link tokenizer. Mentions take no
  formatting (the serializer can only wrap text in marks).
- Rendering always goes through ProseMirror's schema (StarterKit + task lists
  + the link node), which drops anything else — scripts, images, raw HTML from
  an email digest. Lists, Home and Ask show a plain-text projection
  (`app/src/lib/markdown-text.ts`), so `**` and link syntax never appear.
- Saves are debounced and local-first. The outbox (`app/src/db/sync.ts`) holds
  `create | update | delete | archive | unarchive` ops replayed in order;
  updates to one note coalesce (last write wins per field) and fold into a
  not-yet-synced create. A note isn't created until it has content.
- Archive (with an Undo toast) and Delete permanently (confirmed) live in the
  note's overflow menu, beside Copy link.

### Voice

Dictation (the mic in a note's toolbar) and spoken Ask questions share one
component (`app/src/components/voice.ts`): a mic button that turns into a
recording bar in place of the host's own controls (timer, level meter,
cancel, done), then into "Transcribing…", and explains failures inline
(offline, microphone blocked, retry) because toasts sit under an open sheet.
Capture is `app/src/lib/recorder.ts` (MediaRecorder at ~32 kbps plus an
AnalyserNode for the meter; a recording that never rises above room noise is
dropped on the device). In the editor, `app/src/editor/dictation.ts` marks the
caret with a ProseMirror decoration whose position is mapped through every
edit, so text lands where you started even if you keep typing, and inserts
the transcript as text nodes, never parsed as HTML or Markdown.

The server side is one route, `POST /api/voice/transcribe`, with the raw
recording as the body. It's the same handler and bearer auth as the rest of
the API, but enters through `netlify/functions/voice.ts` (which re-exports
`api.ts`'s handler) so `/api/voice/*` can carry a code-based platform rate
limit without limiting sync; `api.ts` excludes that path. `lib/voice.ts` is
the provider module: Gemini `gemini-3.5-flash` through Netlify AI Gateway with
thinking at "minimal", a verbatim-transcription prompt with an explicit
no-speech marker, a 4 MB body cap and a 45 s upstream timeout. It's the only
file that names a provider or model.

The provider was chosen by probing the gateway (November 2026): it forwards
JSON bodies only, so OpenAI's multipart transcription endpoint is rejected,
and OpenAI TTS and Realtime aren't routed; Gemini accepts base64 audio inside
JSON. Measured through the gateway: about 1.4 s for a 4 s clip, 3.3 s for
101 s and 4.6 s for 202 s, so the 3-minute dictation cap sits well inside the
60 s synchronous function limit. No TTS model is offered, so briefing playback
isn't built. Neither audio nor transcripts are stored or logged; the cost is
AI Gateway credits (README "Voice").

### Saved

Links, images, quotes, snippets and notes kept from anywhere (`lib/saved.ts`, `lib/saved-rules.ts`, migration `0038`; contract in `docs/notes/saved.md`). One table, `saved_items`, sealed like notes; images sealed in the `athena-saved` blob store. A link's row is inserted first, from its address alone, and updated after its page is read, so a failed read still leaves the saved link. The page is read once through the guarded public fetch and Readability (`lib/saved-fetch.ts`, `lib/saved-extract.ts`) for a readable copy, title, author, date and lead image; videos and posts keep the preview. Ways in: `POST /api/saved` (capture key: the browser extension and the Share-sheet Shortcut), Siri/Share text that is or starts with a link, or an image, through `/api/assistant/capture`, the installed app's Web Share Target (`/share-target`, handled in `sw.js`, landing on `#/saved/shared`; another site's POST is refused, and a share the worker can't place waits for a tap on Save, `SECURITY.md` §11), and the box on the page. The app shows them in Library → Saved (`views/saved.ts`: cards, filters, search, reader), on the day they were saved (`components/day-saved.ts`, merged with the apps' saved links), in ⌘K, and to Ask through the `saved` tool (`saved:<id>` citations).

**Saved actions** (`lib/saved-actions.ts`, `lib/saved-action-rules.ts`, `lib/saved-kinds.ts`, migration `0039`; notes in `docs/notes/saved-actions.md`). At save time a link's page is read as a type (book, film, show, product, recipe, place, event, article, video) from its JSON-LD, Open Graph or a known site, with facts like the author or price (`thing`, sealed `facts`). A registry of actions, each with `appliesTo`, `fit`, `params` and `run`, says what can be done with an item; the built-ins run through Ask's own tools (`runAssistantTool`), so a gift idea lands on the same "<Name> · Gift ideas" list Ask would use. An action that files the item sets `filed_at` and a sealed `filed_to` (label, app link, undo): it leaves the main list for the Filed filter, and Undo reverses both sides. A feature adds an action with `registerSavedAction` from its own module, imported once from `lib/saved-actions.ts`; the API (`GET/POST /api/saved/:id/actions[/:action|/undo]`), MCP (`list_saved_actions`, `run_saved_action`), Ask (`find_saved`, `file_saved_item`, in `lib/assistant-saved.ts`) and the app (`components/saved-actions.ts`) all pick it up.

**Mention edges** (migration `0044`, notes in `docs/notes/mention-edges.md`). A note's @-mentions of a saved item, a to-do or a Watch & read title are `edges` like any other mention, stored under the tables' names: `saved`, `commitment`, `reading` (`lib/links.ts` `EDGE_KIND` maps the link kinds `todo` and `watch`). `EntityType` = `PageType` (what search, reminders, connectors and archiving use) plus `ItemType`. `GET /api/connections/:kind/:id` adds `through_notes` on a page: the items mentioned in notes linked to it, which is how they show on a person's Related chips. The Graph shows a saved item, to-do or title once something links it. Existing notes are re-synced once by the `backfill-content-links` scheduled function (bodies are sealed; progress in `settings` `backfill.content-links`).

### Recipes

Recipes, the week's dinners and the grocery list (migration `0053`; contract and checks in `docs/notes/recipes.md`). A recipe used to be a kind of Saved link with a "Cook" action; now it has its own page in Library → Notes and collections.

- **One fetch, through Saved.** A recipe link is kept in Saved first, which reads the page once (`lib/saved.ts`). When Saved reads a page as a recipe, `saveItem` hands the HTML to `fileRecipeFromSave` (`lib/recipes.ts`), which reads the recipe and files the Saved item to Recipes as its pointer ("Filed in Recipes"). That's how a share, Siri, the extension, a paste in Saved and Ask's `import_recipe` all end up in Recipes. The photo is the Saved item's sealed image. Saved's "Move to Recipes" action (`lib/recipe-actions.ts`) does the same for one put back. `GET /api/recipes` moves a few older Saved recipe links in on each call. A Saved item that a recipe already points at is never moved again (`savedToMigrate`, and a unique index on `recipes.saved_id`).
- **Reading a recipe, without a model** (`lib/recipe-parse.ts`): schema.org Recipe in JSON-LD, then microdata. Durations, yields, sections and authors given by `@id` all count. Ingredient lines are read into quantity, unit, item and note by `lib/recipe-units.ts`, which also scales amounts and switches between metric and imperial, writing fractions for spoons and counts. The same recipe is deduped by a blind index of its canonical address. Try harder, only when the owner taps it, sends the page's text to the model.
- **Pure parts shared with the app.** `lib/recipe-units.ts` (lines, scaling, units), `lib/recipe-steps.ts` (cook mode's timers and each step's ingredients), `lib/grocery.ts` (merging across recipes, the pantry, a small static aisle map) and `lib/meal-plan.ts` (the week's scoring) are pure and shared with the app. `lib/recipe-rules.ts` holds the API's shapes.
- **The week plan.** `getWeekPlan` reads the evenings from the calendar port scheduling uses, plus trips. A late event or travel gets a recipe of 30 minutes or less, a free evening something long or a batch cook, and nothing comes back within 7 days of being cooked. The plan is scored in code, deterministically per week. It's stored (`meal_plan`) only once the owner keeps it.
- **The grocery list** (`grocery_items`) lives in Athena: recipes or a week merged into the open lines, pantry staples (Settings → Recipes) left off, the owner's own lines, ticks. The app caches it on the device and queues ticks made offline.
- **Ask.** `find_recipes` (`lib/assistant-recipes.ts`) is registered on both back ends: the answers path cites `recipe:<id>`. `import_recipe` is the assistant's, with Undo.
- **Routes:** `netlify/lib/recipes-routes.ts`. **App:** `views/recipes.ts` (grid, recipe, cook mode with Wake Lock and timers, week plan, grocery list), `db/recipes.ts` (offline cache and queue), `db/sample-recipes.ts`, `components/recipe-settings.ts`.

### Templates and sending notes out

Templates and documents (migration `0047`, notes in `docs/notes/documents.md`). A template is Markdown with `{{fields}}` (`lib/templates.ts`, pure, shared with the app). Each known field names one source (`FIELDS`). The six starters live in code, and an edited starter or one of the owner's own is a sealed row in `note_templates` (`lib/templates-db.ts`). `lib/template-fill.ts` fills a template from records, never from a model: the event and its people, catch-ups, details, open to-dos, an Email digest note, a trip's bookings, each day's line, a project's links. Every filled part is cited under Sources with `athena://` links, so the new note links to what it came from. A field with nothing behind it stays `{{as written}}`, and the editor highlights it (`editor/template-blanks.ts`). Its opening heading becomes the note's title. A note can be sent to Google Docs (a direct, tool-less account, `drive.file` only, `netlify/lib/connectors/google-docs.ts`) or Notion (`callNotionWrite` in `mcp-client.ts`, opt-in with a parent page in `connectors.write_parent_*`), through `lib/documents.ts` and its ports. `document_exports` lists everything Athena made: sending again updates it, and Undo trashes the doc, or moves the page under a "Removed by Athena" page Athena makes beside it. `lib/documents-rules.ts` holds the Markdown-to-Docs conversion and both write gates. Routes: `/api/templates*`, `/api/documents*` (`netlify/lib/documents-routes.ts`). Ask: `fill_template`, `send_note` (`lib/assistant-documents.ts`). App: "From template" in Notes, "Start from a template" on a new note, the note menu's Send and Save as template, the sent strip, Home's Prepare notes, and the Notion account's Pages group.

### Rich links in notes

A link in a note can show four ways: Mention (a pill), Link (text), Card or
Embed (design and the owner's answers in `docs/notes/rich-links.md`; what
stage 1 built in `docs/notes/rich-links-stage1.md`). The mode is stored in the
note as the Markdown link title, so a body stays plain Markdown:
`[@Priya](athena://person/<id> "card")`, `[A walk](https://… "embed")`. No
title means the default, Mention for things in Athena and Link for web pages;
things in Athena never embed. `lib/links.ts` parses and writes both kinds with
an optional mode, and content-link sync finds a link whatever its mode.

A web link Athena wrote is never previewed: `plainWebLinks()` drops the mode
from model text on the server (replies, answers, the briefing), Ask draws
every web link plain, and in a note the owner didn't write the editor holds
each link plain (`athenaWrote`, `app/src/editor/link-view.ts`). When the
owner picks Card, Mention or Embed for one of those links, the choice is
kept outside the note, in `note_link_choices` (migration `0059`,
`lib/note-link-choices.ts`, `GET`/`PUT /api/notes/:id/link-choices`), which
no model-callable tool writes.

- **Previews** (`lib/link-previews.ts`, migration `0040`): a web address's
  title, summary, site, author, kind and facts, picture and favicon, read once
  through Saved's guarded page reader and kept in `link_previews`, keyed by a
  blind index of the normalised address (the address isn't stored). Good
  reads are kept 30 days, failures an hour. `GET /api/link-preview?url=`,
  pictures at `GET /api/link-preview/:id/image` and `/favicon`. An address
  a connected account can open (a Notion page) is read through it first
  (`registerPreviewSource`; `netlify/lib/rich-links/connector-previews.ts`).
- **Embeds** (`lib/embeds.ts`, pure, shared with the app): a pasted address
  to `{ provider, kind, embedUrl, aspect, … }` for YouTube (on
  youtube-nocookie.com), Vimeo, Loom, Spotify, Apple Music, Figma and Framer.
  Google Maps and Apple Maps have no player: Athena's still, and "Open map"
  opens the maps app picked for the device in Settings → Maps and artwork,
  through `openMapUrl`.
  It reads only addresses, never pasted HTML.
- **Mini maps** (`lib/static-map.ts`): one pin, drawn and cached exactly like
  a day's map. `GET /api/places/:id/map` for a Place (its spot from visits,
  else its typed address looked up once on Nominatim and cached),
  `GET /api/link-map?url=` for a Google Maps or Apple Maps link's still.
- **Old previews**: a monthly sweep deletes previews not used for 90 days,
  with their pictures.
- **Watch & read meta** (migration 0063): `reading_items.meta` is one
  sealed JSON value (`lib/watch-meta.ts`): year, running time, pages,
  genres, playlists, the owner's tags and the seasons a title suits.
  `netlify/lib/watch-enrich.ts` fills it once per item after
  `GET /api/reading` replies (YouTube `videos` and the playlists in Days,
  TMDB or Trakt, Open Library). The page shelves Up next by kind, playlist,
  genre, length or maker, and shows a "For Christmas" (Halloween,
  Valentine's, Summer) shelf from the owner's own lists while that season
  is on.
- **Watch & read progress** (migration 0042): `reading_items` keeps
  `progress_unit` (`page`, `episode` or `percent`), `progress_done` and
  `progress_total` (rules in `lib/watch-read.ts`). The API, MCP and Ask read
  and write it as `progress`; live cards draw it.

Routes: `netlify/lib/rich-links/routes.ts`. The editor nodes, switcher, peek
and players are stage 2.

### Ask's conversations

Ask keeps every conversation, on every device (`ask_threads`, migration
0017; `lib/ask-threads.ts` on the server, `app/src/db/ask-threads.ts` on the
device). It opens on your last conversation, unless you've been away 12
hours, then on a new one; New starts another, and the Conversations list (a
sheet on a phone, a column beside the conversation at 1200px and wider)
switches, renames and archives. Archived ones wait on the Archived page.

- **What's kept.** Your words; the assistant's replies with the turns sent,
  so it keeps context when you come back; written answers' text and their
  sources. Search results and Athena's own sources are kept by id and kind
  only, and reopening loads them as they are now: anything deleted since
  drops out. A connected account's source (an email, a call) keeps its
  title, since it can't be loaded again. Undo on an old change hides if the
  note has moved on or the server refuses it.
- **Sync.** Writes go to IndexedDB first, then up as a whole conversation
  (`PUT /api/ask-threads/:id`, newest `updated_at` wins); pulls take what
  changed since the last (`GET /api/ask-threads?since=`) plus every id, so a
  conversation deleted elsewhere leaves. Same beat as notes (`runSync`), and
  when Ask opens. Sample mode stays on the device.
- **Search.** On the device, offline too: the list's search box, "In past
  conversations" under Ask's answers, and the search bar (Notes) all read
  the decrypted copies here. The server never searches them.

### Plans, routines and What Ask did

- **Plan, then Go** (`lib/ask-plans.ts`). While the assistant works, every tool
  that could change something goes to a `PlanDraft`, which keeps the call and
  tells the model it's queued, with a stand-in id later steps can use. Looking
  tools, `find_times` and `create_event` (which wait for their own tap) run as
  before. When the model finishes: one change runs then, as it always did;
  two or more are kept as an `ask_plans` row (migration 0055, sealed) and the
  reply carries a plan card. One change is also kept as a plan when the guard
  holds it (`plan.why`: the turn had read other people's words and the owner's
  message didn't ask for it, or something read was flagged), and the card says
  why. Each step can be ticked off; Go
  (`POST /api/assistant/plan`) runs the ticked ones in order through
  `runPlanTool` (the same tool code, plus the move a reply would leave to the
  confirm sheet), swaps stand-ins for what earlier steps made, skips a step
  whose input needed an unticked or failed one, and returns one receipt per
  change. Undo all (`/api/assistant/plan-undo`) undoes them newest first.
  A Shortcut capture still runs each change as it comes.
- **Routines** (`lib/routines.ts`, `lib/routine-run.ts`). Recurring Ask
  questions on chosen weekdays at a time in the owner's zone, made from Ask
  (`save_routine`) or Settings → Ask, at first. Routines are assistants now
  (below); `/api/routines` is closed and answers every call with 410 Gone and
  `{ error: "Routines are assistants now. Use /api/team.", use: "/api/team" }`
  (owner, 13 Nov 2026). It used to list, create, edit and delete them, up to
  10. The reminders run claims each due slot once in the row and hands
  it to `netlify/functions/routine-run.ts` (background). A run goes through
  Ask's one loop with today's context and the server's limits (10 model calls,
  24 lookups, wrap-up at about 60 s, stop at 120 s, effort medium; owner, 12
  Nov 2026; once it queues a change, up to 14 calls in four minutes), under
  five minutes of the function's 15. It runs in "propose" mode, where nothing
  is made and even one change becomes a plan, in the same reply as its answer. The run is saved as an Ask conversation and its nudge (rule
  `routine`) goes through the shared gate; in quiet hours it waits in
  `pending`. The card and push open the conversation.
- **What Ask did** (`lib/ask-activity.ts`, `ask_activity`). `runAsk`,
  Go and a nudge card's parts log every change with its receipt, Undo op,
  source (ask, plan, routine, nudge) and conversation. Settings → Ask → What
  Ask did lists them newest first with Open and Undo, and shows done, undone
  or couldn't undo. A reply's Undo sends the change's `activity_id`, so the
  log and the conversation agree. One store: nothing scans conversations.
- **Something to watch tonight** (`lib/watch-tonight.ts`). On an evening the
  calendar leaves clear after 19:00, up to three picks from the owner's own
  Watch & read films and shows (Trakt's watchlist included), ranked against
  their ratings and About you, each with why ("You rate slow-burn sci-fi
  highly"). A proactive rule (`watch_tonight`, 17:00 to 20:00, off by
  default, with Fewer like this) and an Ask chip in the evening
  (`GET /api/watch-tonight`). No search, no model call. The chip is its
  own button. The same thing typed goes to the assistant like any message,
  which has a tool for it (`watch_tonight`, owner 12 Nov 2026): it calls
  the same `tonightCard`, and the reply carries `picks`, drawn as the same
  card under one line of text.

- **Team runs** (`lib/team-events.ts`, `lib/team-triggers.ts`, `lib/team-run.ts`,
  `netlify/functions/team-run.ts`). Hooks emit `team_events` (collected items,
  including the orders, bookings, dates, renewals, alerts and to-dos email
  sets off; saves and saved actions; tagged notes). Every 5 minutes reminders claims new
  events and due schedule slots once each and queues `team_runs`; the
  background function runs one through `runAssistantTurn` (`lib/team-chat.ts`):
  allowed tools run, the rest wait as a plan, and the turn keeps the
  conversation. The runner checks `paused` and records the run. Routines became assistants (`lib/team-migrate.ts`,
  guarded by the `team.routines_migrated` setting); `save_routine` now makes
  an assistant, and `/api/routines` answers 410 Gone, pointing at `/api/team`. Then assistants' triggers
  became flows (`lib/team-flows.ts`, guarded by `team.triggers_moved`): a
  moved trigger never fires here, its flow does (see Flows). Team's pass still
  runs any trigger not yet moved, Run now and assignments' stages.

### Team

Named assistants, each with one job, its own triggers, memory and
character. Ask leads them. The spec, with the owner's decisions and the
contracts between slices, is `docs/team.md`.

- **Store** (migration 0067). `team_assistants` (words and memory sealed, at
  most 12), `team_triggers` (schedules and event filters, plain),
  `team_events` (what arrived, kept 7 days), `team_runs` (summary sealed), and
  `ask_threads.assistant_id`.
- **Code.** Types are in `lib/team-types.ts`, shared with the app. The
  character from a seed is `lib/team-seed.ts`. CRUD is `lib/team.ts`,
  served by `netlify/lib/team-routes.ts` (`/api/team`). In the app:
  `db/team.ts` (sample mode: `db/sample-team.ts`), `team/avatar.ts` and
  `views/team.ts` (`#/team`, `#/team/<id>`, `#/team/new`).
- **Each assistant's mind** (`lib/team-chat.ts`, `lib/team-memory.ts`,
  `lib/team-draft.ts`). A turn as an assistant is Ask's own back end with a
  persona block (name, job, instructions, tone as voice only, its memory, its
  allowlist), no main-Ask past chats, and its allowlist letting those changes
  run while the rest wait for Go. Memory (a summary and 30 facts) is
  rewritten by one small model call when a chat goes quiet (debounced per
  thread) and after each run. Main Ask can `check_with_assistant`: a
  read-only, time-capped turn whose answer becomes a source of kind
  `assistant`. Setup's draft is one structured call checked with zod, with
  a plain fallback.
- **Its own skill** (migration 0069, `lib/team-skill.ts`,
  `lib/team-skill-make.ts`). Setup asks 2–4 questions for the job
  (`POST /api/team/questions`, one Haiku call, none on failure), and when
  the assistant is added Athena writes a SKILL.md from the job, instructions
  and answers (plain template when the model can't), after the response.
  It's an `ask_skills` row with `assistant_id` (cascade delete, kept off):
  every turn as that assistant loads its body into the persona block
  (clipped to 12,000), and main Ask never lists, picks or loads it. The
  skill keeps fingerprints of the job it matches and the body as written, so
  the assistant's page can offer an update with a preview when the job or
  instructions change; nothing replaces it unless the owner accepts.

- **Assignments, guests and Team chat** (migration 0076; spec in
  `docs/team.md` "Assignments"; contract `lib/assignment-types.ts`; notes
  `docs/team-notes/assign-integrate.md`). One piece of work passed along a
  line of assistants, ending in a document.
  - **Store** (`lib/assignments.ts`). `team_assignments` (title and brief
    sealed) and `team_stages` (task, handoff, questions and answers in one
    sealed `words`). A guest is a `team_assistants` row with `assignment_id`
    and `role`, made from the lineup stage's `seed`; it's off `/api/team`,
    the 12 and `/api/team/activity`, has no triggers, and
    `POST /api/team/:id/keep` clears `assignment_id` (409 at 12).
  - **Lineup** (`lib/assignment-lineup.ts`, `lib/team-roles.ts`). One
    structured call checked with zod, with a plain fallback; nine roles in
    code. Nothing runs before Go.
  - **The runner** (`lib/assignment-run.ts`). Each stage is a `team_runs` row
    with `stage_id`, run by the team-run background function through
    `runAssistantTurn` mode `run`. The stage's message quotes the brief, the
    work and every handoff as data. `hand_off` (with the whole document in
    `work`) and the stage's `ask_owner` are offered only inside a stage's
    turn (`lib/assignment-tools.ts`) and are never plan steps. The runner,
    never an assistant, moves the work on: next stage, a question, an
    approval, a plan waiting for Go, done, or failed. `sweepAssignments`
    runs after a plan's Go and on each reminders pass.
  - **Ports.** The runner imports nothing of Team chat or documents:
    `netlify/lib/assignment-wiring.ts` calls `configureAssignments` with
    `postToTeam`, `settlePosts`, `documentsForNote` and `makeDocument`, and
    is imported by the api, team-run and reminders functions.
  - **Team chat** (`lib/team-posts.ts`, `netlify/lib/team-chat-routes.ts`).
    `team_posts` (body sealed) points at its run, stage or assignment and
    never copies it. `GET /api/team/chat` answers a page and `waiting`,
    whose length is the one count. `POST /api/team/chat` sends what's typed
    to a stage that asked (`ChatDesk`, in `api.ts`), to "@Name" as a chat
    turn, or to Ask; it's claimed by the Netlify Server
    (`netlify/server/routes/team-chat.ts`) so it shares Ask's rate limit.
    `POST /api/team/chat/:id/dismiss` settles a run or stage that didn't
    finish. A Team run's push and Home card link to `/#/team/chat/<post id>`.
  - **Documents** (`lib/document-make.ts`, `lib/document-make-db.ts`,
    `lib/assistant-documents.ts`). A note becomes Markdown or Word (a
    hand-written stored zip, `marked` for parsing; the same converter runs
    in the app for sample mode). `make_document` is a change tool with a
    receipt and Undo; `POST /api/notes/:id/document` is the note menu's
    Download; `GET /api/files/:id/download` sends any file as an
    attachment. A made file carries `files.made_from_note` and, from a
    stage, `files.stage_id`. A finished assignment's two files are made by
    the runner.
  - **Ask.** `start_assignment` keeps a draft and puts the lineup on the
    reply (`AskActed.lineup`), drawn as a card with Go;
    `continue_assignment` approves a checkpoint or takes suggestions.
  - **App.** `app/src/db/assignments.ts`, `db/team-chat.ts`,
    `team/chat.ts`, `team/chat-posts.ts`, `team/lineup-card.ts`,
    `team/new-assignment.ts`, `team/assignment-page.ts`, `team/waiting.ts`;
    routes `#/team/chat`, `#/team/chat/<post id>`, `#/team/assignment/<id>`;
    sample mode in `db/sample-assignments.ts`.

- **Sharing and importing assistants** (`lib/team-share.ts`, pure and shared with the app;
  `lib/team-share-store.ts`; routes in `netlify/lib/team-routes.ts`; app
  `db/team-share.ts`, `team/share-sheet.ts`, `team/import-sheet.ts`,
  `team/share-words.ts`). An assistant as a file someone else can import: a
  folder (zipped for download) with `assistant.json` (format 1: name, job,
  instructions, summary, personality, avatar, triggers without ids, `asks`,
  `needs`, `would_like`, `web`, and optional `version`, `author`,
  `based_on`), its `SKILL.md` and the skill's files. Migration 0086 records
  an import (`team_assistants.origin = 'shared'`) and the accounts ticked for
  it (`team_assistants.accounts`).
  - **Share** (the assistant's page): `POST /api/team/<id>/export` with
    `edits` and `fine` returns a `ShareExport`: the file's contents with
    links into this Athena taken out (`scrubText`), and `findings` from
    `findPersonal` against `knownTerms()` (people, identities, places,
    organisations, projects, the owner's profile, connector labels). The
    setup questions kept with its skill become `asks`; the owner's answers
    don't go. `download: true` gives the zip, or 409 with the findings.
  - **Import** ("Or import one someone shared" in New assistant, the empty
    Team page, a drop on the page, or `#/team/import` from the share target):
    `POST /api/team/import/preview` reads a zip, a folder's files, an
    `assistant.json` or a GitHub link (`parseShareLink`, `fetchGithubFolder`
    in `lib/skill-fetch.ts`) into an `ImportPreview` with each needed
    account's connection, `asks_first` (what it asked to do alone that an
    import can't grant) and `accounts` (every account a turn could open, the
    ones it needs first). `POST /api/team/import` makes
    the assistant paused, with `grantedTools` (asked for, ticked, and in
    `SHARED_TOOLS`: the flows catalogue's "add" group plus `track`,
    `lib/shared-limits.ts`), the accounts ticked, and its
    skill as the assistant's own (`putAssistantSkill` with the file's
    files and source), the owner's answers appended (`withAnswers`); with no
    skill, `attachSkill` writes one after the response. An assistant with no
    looks gets the character its preview showed (`shareSeed`).
  - **What an imported item reaches** (`lib/shared-limits.ts`,
    `lib/shared-scope.ts`, `lib/shared-scope-db.ts`). An imported assistant's
    turns (chat, run, a flow's think step) carry an `AccountScope` of its
    ticked accounts (`runAssistantTurn`); an imported skill (source `upload`
    or `link`) limits the turn when it comes into use (`SkillTools`' `onUse`)
    or, picked with "/", before anything opens. `runAsk` opens only allowed
    accounts (`SourcesPort.open`'s `only`, honoured in
    `netlify/lib/connectors/answer-sources.ts`), drops the others' tools,
    refuses a call to one, and wraps the Session's mail, Slack and calendar
    ports (`scopedPorts`). Their words reach the model as someone else's:
    `<shared_instructions>` and `<shared_skill>` in the persona block, and
    `SHARED_SKILL_RULE` for an imported Ask skill. The app's ticks are
    `components/account-ticks.ts` (import sheet, `team/detail-accounts.ts`,
    the skill page), and Home's one-time `components/accounts-notice.ts`
    reads `GET /api/skills/notice`.
  - **Needed accounts.** The file's `needs` are kept with the imported
    assistant's sealed words (`Words.needs`, `cleanNeeds` in `lib/team.ts`;
    `TeamAssistant.needs`). The import sheet and the assistant's page list
    those accounts first and, while one is unticked, show
    `cantWorkNote` ("Dot can't work without Linear.", from `unmetNeeds` and
    `cantWorkWords` in `lib/shared-limits.ts`). The "Always asks first" rows
    take their words from `ASKS_FIRST_TOOLS`.
  - **Go on an imported assistant's plan.** `runAsk` saves the plan with
    `limit: { assistant_id }` when an imported assistant proposed it.
    `goPlan` (`lib/ask-plans.ts`) runs its steps under `underGoLimit`: the
    step runners' ports go through `limitedForGo` (strict `scopedPorts`, where
    a look is refused too and the refused account is recorded). A step
    that was refused and made nothing stops Go before it: the payload keeps
    `paused` (the step, the account, the ticks and the results so far),
    `ran_at` goes back to NULL so it still counts as waiting, and the card
    carries `needs_account`. `POST /api/assistant/plan` with `account`
    (`once`, `always` or `skip`) carries on from that step (`carryOn`): once
    adds the account to this Go's scope only, always ticks it for the
    assistant, skip leaves the step out. Go and an answer claim the plan by
    the sealed payload they read. The app draws the question in
    `accountAskEl` (`views/ask.ts`); sample mode's imported Dot leaves such a
    plan on Run now (`sampleLimits` in `db/sample-ask-plans.ts`).
  - **Sample mode** checks, previews and imports in the app against the sample
    team and people; a download there is `assistant.json` alone.
  - **The catalogue** is a separate GitHub repository; Athena only reads
    GitHub links and never publishes.

### Flows

A trigger, then steps with branches, beside Team. A plain flow runs with no
character and calls no model unless a step needs one; a flow handed to a Team
assistant runs in its voice, with its memory and allowlist, and can have
thinking steps. The contract between the engine, triggers, drafting,
suggestions and the app is `lib/flow-types.ts`.

- **Store** (migration 0080, `lib/flows.ts`). `flows`: the owner's words
  sealed in `payload`, `trigger_kind` and a word-free `schedule` plain for the
  jobs, `assistant_id` when handed over. `flow_runs`: label, summary, error
  and `state` (each step's line, the values steps gave, a stack of where the
  run is in the tree, what it waits on, the cards it owes) sealed; status,
  `waits_for`, `resumes_at`, the Ask plan or assignment it waits on, the ids it
  made, the run that started it (`started_by`) and the flows before it
  (`chain`), and a `version` for compare-and-set plain. Checking a flow
  against `FLOW_LIMITS` (choices from `minChoices` to `choices`) and its chips
  (each must point at the trigger or a step before it) is `checkSteps`; a
  change with no Go setting gets `defaultGo` (`fillGo`): only `add_reminder`,
  `add_todo` and `add_to_list` run alone, and a draft is refused unless it
  waits for Go. Every run read carries `values`: the trigger's and each step's,
  as words (`shownValues`, from the sealed state). `createFlowSource()` and `createFlowStarter()` are the
  ports triggers uses; what a trigger gives is triggers' own (`triggerGives` in
  `lib/flow-triggers.ts`, kept pure in `lib/flow-trigger-gives.ts`), which
  drafting, suggestions and the app's sample mode read too.
  `lib/flow-engine.ts` plugs the engine in: imported by `api.ts`,
  `reminders.ts` and `mcp.ts`, it hands triggers the source and starter (so
  the reminders pass and the owner's own events start runs), gives Ask's
  `propose_flow` the engine's `createFlow`, and gives suggestions the
  owner's flows. Deleting a flow deletes its `flow_trigger_fires` rows. The starter's chain guard (`startedByRun`, `chainFor`)
  traces an event to the run that made its record and refuses a flow already
  in that chain, or a fourth run.
- **Catalogue** (`lib/flow-catalog.ts`, `GET /api/flows/catalog`). Ask's own
  tools, as an allowlist of looks, changes inside Athena (filing a saved
  item, `file_saved_item`, among them) and drafts
  (`draft_email`, `draft_message`, group `tell`, always waiting for Go), plus
  Check, Ask me, Wait, Tell me, Think and Start an assignment. Go on a draft
  writes it with `runAssistantTool` and Ask's mail and Slack ports, and keeps
  it as a `draft` change to read and save (`draftChanges`); nothing is sent.
- **Runner** (`lib/flow-steps.ts` pure, `lib/flow-run.ts`, real effects in
  `lib/flow-effects.ts`). A run is queued, then claimed once by the
  background function `netlify/functions/flow-run.ts` (`/api/flow-run`). It
  walks until it ends or waits: tools through `runAssistantTool`, a change
  set to ask becomes an Ask plan and the run waits for Go; Ask me waits for
  an answer; Wait for a time; Start an assignment for its lineup's Go and then
  its end; Think is `runAssistantTurn` as the flow's assistant. Each step
  leaves one line from what happened (lib/steps.ts's words), no model. A
  plain flow's changes are What Ask did's source `flow` ("Flow: <name>",
  opening `/#/flows/runs/<id>`); an assistant's stay `team`.
  The owner's Go, Skip and answers settle the wait and queue the run again.
  A dry run uses the last `team_events` row that matched and changes nothing.
- **The reminders job** (`sweepFlowRuns`, `deliverFlowNotices`) carries Waits
  on, moves runs on when an assignment ends or a plan ran from Ask, stops runs
  that waited for the owner 14 days, hands off queued runs a hand-off missed,
  and sends held cards (key `flow:<run>:…`; rule `flow` for a plain flow,
  `team` for an assistant's).
- **Hand and take back** (`POST /api/flows/:id/hand`, `/take-back`). Sets
  `assistant_id`; `"new"` makes an assistant from a fresh seed. A run keeps
  the assistant that started it. A paused assistant's flows don't run, handed
  ones included: they don't start, and a run queued or waiting when it was
  paused stops when it's picked up ("Stopped: <Name> is paused."; its team
  run ends "Paused before it ran.", with no card). Run now and a try still
  run. The flow's page says why ("Moss is paused, so this flow doesn't run").
- **An assistant's run is one record** (`FlowEffects.teamRun`, migration
  0083). A run of an assistant's flow starts a `team_runs` row linked by
  `flow_run_id` (one per flow run), so Team, Home, Recent runs, the quiet-run
  rule, memory and the waits-for-Go count read it as any run; it finishes
  when the walk ends or waits, posts in Team chat once, and its "From <Name>"
  card is Team's (`deliverTeamNudges`). The flow then keeps no end or waits
  card of its own when a think step kept a conversation.
- **Tried once more** (`triesAgain`, `retryFlowTeamRun`; owner, 21 Nov). A
  run of an assistant's flow that a trigger started and that failed before
  anything ran (no change, no plan, no card owed, and no step that may have
  changed something: `RunState.touched`) goes back in the queue once, as this
  go found it, marked `retried`; its team run waits marked retried too ("Trying
  again shortly"), with no card and no post. The next pass hands it off; a
  second failure is told as before ("tried twice"). Not for Run now, a try, a
  plain flow, a stop, or a paused, removed or out-of-budget assistant.
- **Assistants' triggers are flows** (`lib/team-flows.ts`). Each trigger is a
  job flow: the assistant, origin `trigger` (or `shared` for an import), one
  think step whose turn asks what a Team run asked (`thinkFor`, `runPrompt`).
  The reminders job moves every `team_triggers` row once, in one transaction
  (`moveTriggers`: the last slot kept as a claimed fire, `moved_at` set, the
  `team.triggers_moved` setting written); a moved trigger never fires in
  Team's pass. Event batching follows Team: an event fires each assistant's
  first matching job flow only, and a pass's events for its job flows are one
  run; plain flows run per item. After the move `TeamAssistant.triggers` are
  its job flows (`flow_id` set), and `lib/team.ts` keeps triggers it's sent
  (setup, Ask's `save_routine`, the trigger editor, imports) as job flows.
  Job flows count toward an assistant's 8 triggers, not the 40 flows.
- **Think steps** give values as structured fields of the answer
  (`AnswerOptions.values` → `AskReply.values`); `web: false` runs the turn with
  the assistant's web switch off (`TurnOptions.web`). Go from Ask's plan card
  on a plan a run waits on is the run's own Go (`goWaitingFlowPlan`).
- **Routes** (`netlify/lib/flow-routes.ts`): every `/api/flows` route in the
  contract except draft and suggestions, which are drafting's and
  suggestions' own.

### Skills

Skills are SKILL.md instructions, in the same format as Claude's skills, that
change how Ask handles some kinds of request (`lib/skills.ts`, migration 0058,
`ask_skills`, sealed).

- **Format.** Frontmatter `name` (64 characters, lowercase and hyphens, no
  "claude" or "anthropic") and `description` (1024), then a Markdown body.
  Other keys are kept as written and ignored. Reference files: .md .txt .csv
  .json only, 100 KB each, 400 KB and 30 files a skill. Scripts and binaries
  are listed as "Not used", never kept. Downloads (SKILL.md, or a .zip with
  its files) go back to Claude unchanged.
- **Ways in.** Upload a SKILL.md, a .zip (`lib/skill-zip.ts`) or a folder;
  write one; import from a GitHub folder or a raw SKILL.md link
  (`lib/skill-fetch.ts`); or "Make this a skill" in Ask's menu
  (`lib/skill-draft.ts`), which drafts one from the conversation and opens
  the editor. Every import is a preview (`POST /api/skills/preview`) before
  anything is saved; a draft is never saved or switched on by itself, and
  one from a file or a link is saved off whatever the request says
  (`createSkill`). Three starters (weekly-review, plan-meals, meeting-prep)
  are added once, off.
- **Imported skills' accounts** (migration 0086, `ask_skills.accounts`).
  While Ask uses a skill from a file or a link it opens only the accounts
  ticked on the skill's page (see Team, "What an imported item reaches").
  The first read after 0086 notes the imported skills there were then
  (settings `skills.accounts_notice`, ids only); `GET /api/skills/notice`
  lists those still with none ticked until `DELETE` marks it read.
- **Assistants' own skills** (0069, `assistant_id`) are listed in Settings
  under Team with the assistant's avatar and name, no switch. They never
  count toward the 50, and Ask's list, "/" and `use_skill` skip them (see
  Team).
- **In Ask** (`lib/skills-ask.ts`). Both back ends list the enabled skills in
  the system prompt (at most 20, 300 characters each, 4,000 in all) with
  `SKILL_RULE`, and offer `use_skill` (the body and file list) and
  `read_skill_file` (one file). The back end runs those two itself, before
  the assistant's Session, so they're never plan steps. "/" in the Ask box
  picks a skill (enabled ones, best match first); its id goes with the
  request and its body is loaded into the message before the model runs.
  Each use is counted (`uses`, `last_used_at`), kept in What Ask did as a
  `skill` change with Open and no Undo, and named under the reply ("Used:
  Deal notes", a link to the skill).
- **App.** Settings → Ask → Skills is a full page, `#/settings/skills` and
  `#/settings/skills/<id>` (`components/skills-page.ts`, `db/skills.ts`):
  the list with switches, last used and source; the editor (Name, Use when,
  Instructions, files); upload, link and new. Sample mode keeps the starters
  and one skill in use on the device.

### Files

Photos (the phone camera too), screenshots, PDFs and Markdown/text files,
added in Ask or to a note (migration 0019; `lib/files.ts` on the server,
`app/src/components/attachments.ts` on the device).

- **One store.** Bytes go to Netlify Blobs (store `athena-files`, key = the
  file's id, `<id>-thumb` for a photo's preview), sealed under
  `ATHENA_DATA_KEY` first (`sealBytes`, SECURITY.md §11). The `files` row
  has the sealed name and the readable type, size, pixels and page count.
  Nothing is public: `GET /api/files/:id[/thumb]` sends it back to the
  bearer token only.
- **On the device first.** A photo is shrunk before it uploads (1568px long
  edge, about 1.15 megapixels, JPEG; PNG stays PNG), with a 480px preview.
  Up to 4 MB a file and 5 a message. Uploads start as soon as a file is
  picked (`POST /api/files`, multipart, linked to the conversation or note).
  Bytes are cached here (Cache Storage), so a file seen once opens offline.
- **In Ask.** A message keeps its files' ids and descriptions (name, type,
  size), never bytes, so the same thumbnails show on every device. Images
  and PDFs go to Claude as image and document blocks, text as a text
  document, for the newest message's own files. The first read also makes
  one summary call per file (`summariseFiles`, run alongside the reply;
  Haiku 5.5 unless `ATHENA_FILE_SUMMARY_MODEL` says otherwise) that
  stores the summary and the words. Follow-ups send earlier files as their
  summary (`summaryBlocks`; a file with none yet is summarised then), and
  the assistant and written answers get `read_file` to fetch an original
  when the summary isn't enough. Requests carry `files` (read whole) and
  `earlier` (summaries). Replies return `file_summaries`; the app keeps them
  on the message, so Conversations search matches them. Requests with files
  are prompt-cached. Steps say "Reading receipt.pdf".
  The assistant's `attach_file` puts a file from the conversation on a note
  (Undo takes it off). Like every assistant tool, `attach_file` and
  `read_file` aren't strict: their schemas are closed and each call is
  checked before it runs. A written answer that hands off to the assistant
  hands over the message's files with it. Offline, files wait in the tray and upload when the
  connection is back; the typed question stays.
- **On a note.** A Files section: add, open, remove (Undo for six seconds,
  then `DELETE /api/notes/:id/files/:fileId`). `GET/POST /api/notes/:id/files`.
  A file with a summary shows it folded to one line beneath it (a disclosure
  button, `aria-expanded`); opened, it spans the row below its file.
- **Keeping and deleting.** `note_files` goes with its note; `thread_files`
  is written as a file uploads and again whenever a conversation is saved.
  Archiving keeps everything. When nothing uses a file any more (a note or
  conversation deleted for good, a file taken off), `sweepFiles()` deletes
  the row and the bytes. Only a deploy with the key deletes bytes. Deleting
  a note for good, from the note or from Archived, offers to delete files a
  conversation still has (`?files=delete`, `deleteFilesForGood`); the app marks them `removed` in
  its conversations, and a tile whose file answers 404 shows as deleted.
- **Sample mode** keeps files on the device only.

### Talk (ElevenLabs)

Talk is a spoken back-and-forth in Ask, with the owner's own ElevenLabs
account. The connection is one `settings` row (`elevenlabs`: the API key
sealed with `lib/secret-box.ts`, the chosen voice, connected or rejected),
read and written by `lib/voice-settings.ts`, so no migration. Connectors
shows it as a **Voice** group (`app/src/components/voice-connection.ts`):
setup steps and a key field, then the voice, this month's credits, Hear it,
New key and Remove, and a voice picker that plays ElevenLabs' free samples.
`lib/elevenlabs.ts` is the only file that knows ElevenLabs' URLs, models and
formats; `netlify/lib/voice/routes.ts` serves `/api/elevenlabs` (through
api.ts) and `/api/talk/*` (through the Netlify Server,
`netlify/server/routes/talk.ts`, which rate-limits it in code).

A turn (`app/src/talk/`, a lazy chunk loaded on the first tap):

- **Listening.** `POST /api/talk/listen` mints a single-use `realtime_scribe`
  token (15 minutes, one connection) and returns the WebSocket URL for
  **Scribe v2 Realtime** with voice activity detection (a 1.2 s pause ends a
  turn), background-audio filtering and no filler words. The page opens it
  itself; `talk/mic.ts` captures with Web Audio (an AudioWorklet, or a
  ScriptProcessor where there's none), averages down to 16 kHz PCM and
  sends 100 ms chunks, buffering the first ones until the socket is open.
  Partial text shows as it's heard. The token for the next turn is fetched
  while Athena thinks or speaks.
- **Thinking.** The words go through Ask's own `ask()`: Jev's router, a
  written answer (or the keyword search) or the assistant, sources,
  receipts and choices on screen. A tapped choice or
  suggestion during Talk takes the same path and is spoken too.
- **Speaking.** Eleven v4 Turbo (`eleven_v4_turbo`) is only offered on the
  Text to Dialogue WebSocket, and no documented single-use token covers that
  socket, so `POST /api/talk/speak` opens it from the function (`ws`, key in
  the handshake header), sends the line and streams the audio back as raw
  16-bit PCM at 24 kHz. `talk/player.ts` schedules it on the AudioContext
  that the Talk tap unlocked (iOS only allows sound after a tap), so it
  starts while the rest is still arriving. What's said is a written
  answer's text without its citation numbers, the reply's first sentence
  and top match (search) or the assistant's own one or two sentences; the
  rest stays on screen.
- **The session socket.** A Talk session also holds one WebSocket to the
  server (`app/src/talk/link.ts`, `netlify/server/talk/session.ts`), opened
  with a single-use ticket from `POST /api/talk/ticket` (SECURITY.md §12).
  The server keeps one dialogue socket open for the session: each reply
  goes on it as `inputs` with `new_turn` then `flush`, and ends at
  `is_final_audio_for_turn`; `keep_alive` every 15 s holds it open while
  idle, and after 5 idle minutes it is closed and reopened on `warm`,
  which the app sends when thinking starts. The PCM comes back as binary
  frames; `stop` is barge-in (the socket is hung up and the next opened).
  If the kept socket lets a reply down, the session falls back to a
  socket per reply. The server closes sessions with 1012 at shutdown and the app
  reconnects. Whenever the socket isn't open the reply goes through
  `POST /api/talk/speak` as above. See docs/netlify-server-talk.md.

The microphone is open only while listening (released before thinking, so
Athena never hears itself, and the iPhone's microphone dot goes out between
turns), and Safari's Audio Session API switches between "play-and-record"
and "playback" so replies come out of the speaker. Tapping the orb while
Athena speaks stops the sound and listens (barge-in); while listening it
means "done". Twelve seconds of silence pauses Talk, a minute caps a turn,
and going to the background, leaving Ask or going offline ends it.
Problems (no key, a refused key, no credits, a blocked microphone) stop
Talk with one plain sentence and, where there's something to fix, a button
to Connectors. With ElevenLabs connected, dictation uses Scribe v2 (batch)
from the function and falls back to Gemini if ElevenLabs fails.

### Why a PWA instead of Obsidian/iCloud sync

The previous design iteration used an Obsidian vault synced via iCloud as the
mobile surface. That approach ties correctness to iCloud's file-sync timing
(which is opaque and occasionally slow or conflict-prone across devices),
requires a markdown-shaped data model that fights against a relational graph
with typed edges and time-series metrics, and has no real offline-write queue
— a conflicting edit is a file conflict, not a resolvable data merge. A
purpose-built PWA with an explicit outbox and a single Postgres source of
truth avoids all three problems, at the cost of writing (a small amount of)
app code instead of pointing an existing app at a synced folder. For a system
meant to be queried and extended programmatically (via MCP, via the REST API),
that tradeoff favors the custom app.

## Obsidian: export, not live sync

An on-demand script (`scripts/export-obsidian.ts`, run via
`npm run export:obsidian`) queries Athena's database directly and writes a
folder of markdown files with YAML frontmatter and `[[wikilinks]]` rendered
from the `edges` table (the owner's own types each get a folder under
`types/`, a file per record) — for portability, periodic backup, or browsing in
Obsidian if desired. It is a one-way, on-demand snapshot, not a live
bidirectional sync. That's deliberately much simpler to build and reason
about than the file-to-DB reconciliation considered in an earlier design
round, and it's all that portability actually requires — nothing reads this
export back into Athena. Content is encrypted at rest, so the script needs
`ATHENA_DATA_KEY` in its shell (README "Encryption at rest").

## Other interaction surfaces

Beyond the PWA:

- **Claude Code / Claude mobile (Remote Control)** — zero extra build, live
  MCP access to source connectors (Gmail, Calendar, Linear, etc.) *and* to
  Athena itself through the MCP server. This is the best surface for
  open-ended natural-language querying ("what did I decide about X last
  month").
- **Siri Shortcut → API** — a planned one-tap or voice capture from anywhere
  on iOS, hitting the same Function API the PWA's outbox uses. Cheap to add
  once the API is live; not yet wired.
- **Dashboard chat widget** (optional, later) — a Function doing a `pgvector`
  nearest-neighbor query over `note_chunks` plus an LLM call, for quick
  questions from a browser without opening Claude.

## Collection model: live query vs. scheduled snapshots

Two different problems get two different mechanisms, deliberately not one:

- **"What's happening right now" (asked occasionally)** is answered by a live
  query: just ask Claude, which hits the relevant source MCP connector
  (Calendar, Gmail, Linear, Slack, Stripe, ...) directly. No scraping
  infrastructure, no stored copy, no staleness to manage — because nothing is
  stored.
- **"What happened over time" (needs history / durability / trend data)** is
  answered by scheduled collection agents, specified in `.claude/agents/` —
  `calendar-meetings`, `work-activity`, `email-digest`, `finance`. These are
  the only four domains that justify durable storage, because they're the
  ones where the interesting signal is a trend or a historical record (meeting
  load over weeks, issue throughput, "did I see that email"), not just current
  state.

Running every domain as a scheduled snapshot would mean storing — and keeping
in sync — a shadow copy of data that's already available live and cheaply via
MCP, for no benefit. Running none of them as scheduled snapshots would mean no
`metrics` time-series ever accumulates, and the "correlated life-metrics view"
idea would have nothing to draw on. Splitting by domain, based on whether
history actually matters for that domain, is the point of the hybrid: it
stores only what needs remembering and queries live for everything else.

As documented in `README.md`, `calendar-meetings`, `work-activity`, and
`email-digest` are now registered as live scheduled Claude cloud routines
(2026-11-05) — the first real OAuth pulls against Gmail, Calendar, Linear, and
Slack. `finance` remains a spec only; registering it (the first real pull
against Stripe/financial data) is a deliberate, separate decision the user
makes later.

## Manual entry: every log takes one

A connector is one way in, never the only one (owner, 14 Nov 2026). Anything
Athena logs from an account can also be typed in by hand, for someone whose
bank, meter, device or app Athena can't connect to, or to add what one missed.
What's typed in is kept the same way as a connector's data, under source
`manual`, so every page, Days, Ask and the briefing read it with the rest.
Shared pure helpers are in `lib/manual-entry.ts`; notes in
`docs/notes/manual-entry.md`.

| Log | Where you add it | Kept as | Wins over a connector? |
|---|---|---|---|
| Spending | Money → Add spending (`spending-sheet.ts`) | a sealed `money` day, source `manual` (`lib/money.ts` `addManualPayment`), each payment with an id | Added to it: both count |
| Health (sleep, steps, weight, resting HR, a workout, water, coffee, drinks, calories, mindful minutes) | Health → Log; a day → Log health (`health-log-sheet.ts`) | a sealed `health` day, source `manual` (`lib/health.ts` `MANUAL_HEALTH`), replaced whole on each save | Yes, figure by figure; the apps fill the rest |
| What you watched, heard, read, played, or anything else | A day → Add to this day (`day-entry-sheet.ts`) | a `day_entries` row, source `manual` (`lib/days.ts` `addManualEntry`) | Folds with the same thing from another source, like any two sources |
| Electricity and gas | House → Add a meter reading (`meter-reading-sheet.ts`) | the readings sealed in one row (`home`/`readings`); the use between two readings spread over the days between as `home` days, source `manual` (`lib/meter-readings.ts`) | No: a smart meter's day wins, fuel by fuel (`mergeHome`) |
| A place visit (a saved Place or a typed address, the day, when you got there, how long) | Library → Places → Add a visit; a day's Places → Add a visit; a Place → Visits → Add a visit (`place-visit-sheet.ts`) | a sealed `location` day, source `manual` (`lib/places-visits.ts` `addManualVisit`), merged into the day by `refreshDays` (`mergeManual`); `GET/POST/DELETE /api/places/visits/manual` | Neither: one that overlaps a Timeline visit or a check-in (within 300 m) is that stop, so the Place counts it once; otherwise a stop of its own. Removing it leaves the other |

REST: `GET/POST/DELETE /api/life/spending`, `GET/PUT/DELETE /api/health/manual`,
`POST /api/days/:date/entries` and `DELETE /api/days/:date/entries/:id` (only an
entry added by hand can be deleted; anything else is hidden), `GET/POST/DELETE
/api/life/readings`. All need full access. Sample mode keeps what's typed in
in localStorage and lays it over the made-up data the same way.

Ask and MCP log all four from a sentence ("I spent £4 on coffee", "slept 7 hours"): Ask's tools only prepare a confirm card and the app saves on the tap through these routes, or the card's Edit opens the same form filled in from it; MCP writes straight away; health is laid over the day's typed figures, never in place of them; Ask offers spending only while "Let Ask read transactions" is on (`lib/ask-logging.ts`, `lib/assistant-logging.ts`, `netlify/lib/mcp/logging.ts`, notes in `docs/notes/ask-logging.md`).

Already manual before this: purchases, trips and bookings, habits, mood, the
journal, Watch & read, events, people and the car (by registration). Places
come from a Timeline file and Swarm, and now one visit at a time by hand
(the table above).

## Connectors: Athena as an MCP client

The routines above run as Claude cloud sessions, and that model has limits
that matter here: a claude.ai account has one connector per service, so a
work and a personal Gmail can't both feed one routine without a second
account; the read-only rules live only in a prompt; and the data path runs
outside Athena. So collection now also runs **inside Athena**, which is an
MCP *client* as well as a server:

- **`connectors`** — one row per signed-in account: the MCP server URL, how
  it signs in (OAuth 2.1 with PKCE and dynamic client registration, your own
  OAuth client where the provider requires one — Google — or a static
  token), its status, and for custom servers on plain OAuth 2 the non-secret
  `oauth` settings (authorization/token URLs when the server publishes no
  metadata, the client-credentials grant for machine-to-machine access,
  client-auth method, audience), which the OAuth provider hands the SDK in
  place of discovery, for Google Calendar and Outlook the calendar ids
  Athena reads (`calendars`, migration 0030; NULL = only the main one), the tools it offers with each one classified
  read/write/unknown, and the allowlist a collection may use. For a custom
  server (migration `0060`): `tool_pins`, a hash of each allowed tool's
  description and schema, and two switches, `use_in_ask` and
  `share_collections`, both off by default. `listAllowedTools` caps tool
  text for every remote server and leaves out a custom server's tool whose
  text no longer matches its pin (`SECURITY.md` §9). Credentials are
  sealed with AES-256-GCM (`lib/secret-box.ts`). Any number of accounts per
  service; each has a label (`work`, `personal`).
- **`collections`** — what to collect (a recipe — `calendar-meetings`,
  `email-digest`, `work-activity` — or custom instructions), from which
  accounts, under which label, and when (daily at a time in your zone, every N
  hours, or manual). The label sets `source` (`email-digest-personal`) and
  the metric suffix (`_personal`), so accounts never merge.
- **`collection_runs`** — history: status, the model's closing summary,
  counts and token usage. **`collected_items`** maps `(source, external_id)`
  to the note it became, so a rerun updates instead of duplicating.

What the Sources screens read (no schema change): each collection in
`GET /api/connectors` carries `current_run` (queued or running) and
`last_run` (status, plain-words `error`, `saved`: new notes, events,
bookings, orders and to-dos, and `blocked_by`: the accounts it couldn't
open, stored in `collection_runs.stats.blocked_by`). A run that reached no
account fails with the reason in your words ("Personal Gmail is signed
out"). `GET /api/collections/:id/runs/:run/items` lists what a run saved:
the collection's `collected_items` whose `collected_at` falls inside the
run's start and finish (a collection's runs never overlap), deleted records
left out, each marked `new` or updated. Bookings and orders aren't in
`collected_items`, so they count in `saved` but have no link. A new account
can reuse another's own Google or Microsoft client with `client_from`
(SECURITY.md §9); `setup.own_clients` names the account it would come from.
Manual collections ignore `enabled`: they never get a `next_run_at`, the
scheduler skips them, and Run now works either way.

Flow: `netlify/functions/collect.ts` (Scheduled, every 15 minutes, 30 s
limit) fails stale runs, claims due collections by moving `next_run_at` on
(so overlapping ticks can't double-claim) and POSTs the queued run ids to
`netlify/functions/collect-run.ts` (Background, 15 min). That opens each
account with the MCP SDK's Streamable HTTP client (`netlify/lib/connectors/mcp-client.ts`,
whose OAuth provider persists every token refresh back into the sealed
blob; Gmail and Google Calendar go to Google's REST APIs instead, below), and runs Claude (`netlify/lib/connectors/runner.ts`) in a manual
tool-use loop. The model sees each account's *allowed* tools, prefixed with
the account (`gmail_work__search_threads`), plus about twenty Athena tools
(notes, people, projects, organisations, links, metrics, to-dos, details,
catch-ups, events, bookings, purchases, receipts, watch & read, health days
and day entries); it never sees a write tool on a source. Athena has no
delete tool for it, and its one archive tool reaches only records that
collection wrote itself (`SECURITY.md` §9). Claude is reached via Netlify AI Gateway (`new Anthropic()`
with injected credentials); the model defaults to Claude Sonnet 5.5
(`ATHENA_COLLECTOR_MODEL` overrides), and a 429 from the gateway's
per-minute spend cap makes the run wait for the next minute, not fail. The recipes in
`netlify/lib/connectors/recipes.ts` are the `.claude/agents/*.md` specs,
with the rules that could only be requested of a routine now enforced in
code. The REST surface is in `netlify/lib/connectors/routes.ts` and the
PWA's Connectors live in Settings, a page each for Accounts, Collections,
Voice and From your iPhone (`app/src/components/connector-settings.ts`);
old `#/connectors` links redirect there.

**Gmail and Google Calendar: Google's APIs, directly.** Google's own MCP
servers (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`) are in
Google's Workspace Developer Preview, and their tools refuse accounts that
aren't enrolled in it. So these two connectors skip MCP and call Google's
ordinary REST APIs, `gmail.googleapis.com/gmail/v1` and
`www.googleapis.com/calendar/v3`, through a narrow adapter in
`netlify/lib/connectors/`:

- `google-direct.ts` opens an account (one cheap read, like an MCP
  handshake: Gmail's profile or the primary calendar, which proves the
  sign-in works and the API is on), lists its tools and runs them, and maps
  Google's failures onto the usual statuses;
- `google-api.ts` holds the token (renewed at `oauth2.googleapis.com/token`
  and saved back sealed), the one request function (GETs, plus the single
  POST that saves a draft), retries for 429 and 5xx, and Google's sign-in
  URLs;
- `google-gmail.ts` and `google-calendar.ts` are the tools.

The tools keep the MCP servers' names and arguments: Gmail's
`search_threads`, `get_thread`, `get_message`, `list_labels`, and
`create_draft` only for an account with drafts on; Calendar's
`list_calendars`, `list_events`, `search_events`, `get_event`. Their output
is compact JSON in the MCP servers' field names, so `precheck.ts`,
`gmail-drafts.ts` and Ask read it unchanged: email bodies as plain text
(`text/plain` preferred, HTML turned into text, quoted replies dropped,
attachments named but never read, a long thread trimmed from its oldest
messages), recurring events expanded into occurrences, and long listings
paged rather than cut off. `mcp-client.ts` hides the difference:
`openConnector`, `listAllowedTools` and `callTool` work the same either way,
so collections, recipes, allowlists, drafts and Ask didn't change.

Sign-in uses Google's own endpoints (`accounts.google.com/o/oauth2/v2/auth`
and `oauth2.googleapis.com/token`) with the owner's OAuth client, PKCE and
the same scopes as before, and no MCP discovery or `resource` parameter.
Accounts added while these went through the MCP servers keep their stored
tokens and allowlist: Google scopes a token by permission, not by server.
There's no migration: the switch lives in the existing `connectors.oauth`
settings, and every Gmail and Calendar account is direct unless
`oauth.google_route` is `"mcp"`. To switch one back to Google's MCP server (when it leaves preview),
`PATCH /api/connectors/:id` with `{"google_route": "mcp"}`, and
`{"google_route": "direct"}` to undo it; the sign-in is kept either way.
There's no switch in the app.

**Outlook mail and calendar: Microsoft Graph, directly.** Microsoft's own
MCP servers for Outlook (Work IQ Mail and Calendar, in Agent 365) need a
Microsoft 365 Copilot licence and a work tenant, so Outlook skips MCP the
same way: `microsoft-direct.ts` opens an account (`/me` plus one read of the
inbox or calendar), `microsoft-graph.ts` holds the token and the GET-only
request function (plus the two POSTs behind switches: an invite answer, and a
new draft or draft reply, `isDraftCreate`), and `microsoft-mail.ts` and `microsoft-calendar.ts` are
the tools, under Gmail's and Google Calendar's names, arguments and JSON
fields. A thread is an Outlook conversation; `search_threads` takes Gmail's
search syntax and turns it into Graph's `$filter` (dates, unread, flagged,
Focused) or KQL `$search` (words, from:, subject:), checking the rest on
each message; bodies come back as text from Graph itself (`uniqueBody`
first, so quoted replies are already gone) and attachments are listed by
name only; `calendarView` expands recurring meetings, with times in UTC.
Sign-in is at `login.microsoftonline.com/common` with the owner's Entra
app, PKCE and delegated read scopes (`Mail.Read` or `Calendars.Read`, plus
`User.Read` and `offline_access`).

**iCloud Calendar and Contacts: CalDAV and CardDAV, directly.** Apple has
no iCloud API or MCP server, but Calendar speaks CalDAV
(`caldav.icloud.com`) and Contacts CardDAV (`contacts.icloud.com`) with the
owner's Apple ID and an app-specific password over HTTP Basic. An iCloud
account is `auth_type` "token": the password is the token and the Apple ID
sits beside it as `username` (a preset's `username` field, asked for in the
connect form and sealed with the key). `icloud-dav.ts` holds the one
request function (GET, PROPFIND, REPORT), a small XML reader and discovery
(`current-user-principal`, then `calendar-home-set` or
`addressbook-home-set`, which points at the account's partition server,
`pNN-caldav.icloud.com`). `icloud-calendar.ts` keeps Google Calendar's tool
names, arguments and JSON fields: one time-range REPORT per calendar with
`CALDAV:expand`, and `icloud-ical.ts` expands whatever iCloud leaves as a
series (RRULE, RDATE, EXDATE, moved or cancelled occurrences), in the
event's own zone so 09:00 stays 09:00 across a clock change. The owner chooses which calendars Athena reads (kept in the
account's `scope`, empty for all; `GET /api/connectors/:id/calendars` lists
them with how busy each is). `list_events` and `search_events` read every
chosen calendar unless a `calendarId` names one (iCloud names no default, and owners spread events
across several). Google Calendar and Outlook use the same picker
(`calendar-picker.ts`, `calendar-choice.ts`), with their choice in
`connectors.calendars` since `scope` holds their OAuth scopes: only the main
calendar until the owner switches more on, and events from several are
labelled with `calendar` and `calendarId`. Gmail and Outlook mail have the
equivalent for email: the owner's rules (`lib/mail-rules.ts`, sealed in
`connectors.mail_rules`, migration 0043) are carried by the opened account
(`mail-guard.ts`) and checked by every mail tool, so a run, Ask or MCP never
sees what they skip; runs record counts in `mail_skips`. The settings
section is `mail-rules.ts` (`/api/connectors/:id/mail`, `/mail/labels`,
`/mail/preview`). With "Let Athena answer invites"
on, iCloud's `respond_to_event` changes only your own PARTSTAT, with a
conditional PUT (`icloud-rsvp.ts`). Times come out
in the owner's zone; an event's id is its file plus, for an occurrence, its
original start, so `get_event` is one GET. `icloud-contacts.ts` lists the
address book's cards (PROPFIND), reads them with `addressbook-multiget` in
batches of 200 and searches and sorts them itself (iCloud's server-side
text search is uneven); photos and contact groups are dropped. In a Meetings
collection, each person a run links is looked up in Contacts
(`icloud-people.ts`: exact email, else a unique exact name) and People's
empty phone, birthday and company are filled in, by Athena, not the model. A second
iCloud account copies the Apple ID and password from the first on the
server (`key_from`), so one password covers both. Ask offers
`search_events`/`list_events`/`get_event` (kind "event") and
`search_contacts`/`get_contact` (kind "page"); precheck asks iCloud
Calendar (and Google and Outlook calendars) for events since the last good run,
so a quiet day skips Claude, unless the collection's "Skip days with nothing
new" (`skip_quiet`) is off. A collection that syncs upcoming events is quiet
only when those still match what it saved. A new app-specific password on one
iCloud account goes to every account that shared the old one.

**Life log sources: Trakt, YouTube, Letterboxd, Goodreads, directly.**
None publishes an MCP server any client can use, so each has a GET-only
adapter. `feeds-shared.ts` gives them one tool contract: `after` / `before`
(a day in the owner's time zone or an exact time), `limit`, `page_token`,
and compact JSON with titles, creators, the owner's day and time, a link
and a `count`. `trakt-api.ts` / `trakt-direct.ts`: the owner's Trakt app,
PKCE, history, watchlist, ratings and paused playback from `api.trakt.tv`;
Trakt rotates the refresh token, which is saved back. `youtube-direct.ts`:
the YouTube Data API v3 with `youtube.readonly` on google-api.ts's
`GoogleSession` (the owner's Google client); liked videos, playlists and
subscriptions. YouTube shares no watch history. `feeds-letterboxd.ts`:
the public diary RSS (`letterboxd.com/<name>/rss/`). `feeds-goodreads.ts`:
Goodreads retired its shelf RSS around 28 October 2026, so it reads the
public shelf grid and bookshelf widgets as text and remembers, in the
account's sealed credentials, when it first saw each book; that day is the
book's `noticed_on`. Letterboxd and Goodreads have no sign-in (`auth_type`
"none"); the address the owner pastes goes through the adapter's
`checkAddress` when the account is added, and only the service's own host
is ever fetched. Precheck asks each for anything since the last good run
(Letterboxd by day, Goodreads by what it's seeing for the first time), so a
quiet day skips Claude.

**History on connect** (`netlify/lib/connectors/backfill.ts`, migration `0054`, notes in `docs/notes/backfill.md`). A run only reads its look-back window, so connecting an account used to bring nothing older. A direct adapter with history now offers `backfill`: streams (Trakt's history, ratings and watchlist; YouTube's likes, playlists and subscriptions; Last.fm, Spotify's saves, Plex, Jellyfin and Letterboxd through their own paged read tools in `backfill-tools.ts`) read a page at a time with no model. Each page goes into Days (`writeEntries`) and Watch & read (`syncWatchRead`), marked `backfilled` and dated when it happened; a day a Life log run already wrote for that source is left to the run. Progress is in `settings` `history_load.<account id>`, saved after every page. Connecting (the OAuth callback, or `/check`) and "Load history again" (`POST /api/connectors/:id/backfill`) start the background function `backfill-run.ts`; the scheduled `backfill-history.ts` carries on loads that ran out of time or were told to wait. Ask's `taste` tool (`lib/taste.ts`) reads the whole history.

**Your activity** (recipe `plays-watches`, called Plays and watches until 12 Nov; migration `0064`, `netlify/lib/connectors/media-sync.ts`, `media-recent.ts`, `activity-recent.ts`, `activity-metrics.ts`, notes in `docs/notes/backfill.md`). A collection with no model: `executeRun` hands it to `runPlaysWatches`, which reads each chosen account's `recent` streams (a direct adapter's: read from a per-account last-seen point and mapped the way the Life log recipe says, with the history load's ids where there is one) and records counts per kind, waits and `blocked_by` on the run. Spotify (plays and saves), Last.fm, ListenBrainz, Trakt (history, watchlist, in progress, ratings), Plex, Jellyfin, YouTube (likes hourly; playlists and subscriptions every 6 hours through `fullRead`) and Letterboxd (`media-recent.ts`); Goodreads, Readwise, Steam, Lichess, Chess.com, Raindrop.io, Eventbrite, Habitify, Todoist (token), Reddit, Bluesky, Mastodon and the health accounts' `day_summary` (`activity-recent.ts`; health goes to sealed health days, the last 3 days every time, plus Polar's `changed_days`). Every hour by default on the collections scheduler, which claims it even without AI Gateway; offered on the connected sheet for those services. Music folds by album a day (`albumDayId`, `hours`); each play's time is kept in `settings` `media_sync.<id>` under a hash so counts stay exact across runs, and the other sources keep what they've counted (`countNew`) the same way, so the run line ("6 plays, 1 watch, 2 books, 1 workout", `lib/activity-words.ts`) counts each thing once. The Life log's daily counts for these sources come from the day's entries (`writeActivityMetrics`), after each hourly run and at the end of the evening run. Its Day entries carry the run id (for "what a run saved"); `BY_MODEL_RUN` tells them from a model run's. The evening Life log run checks the accounts an enabled Your activity collection reads once more, withholds their listings from Claude, adds what's in Days to its context, puts Trakt's ratings on the day's entries, and drops its own entries that repeat ones no model run wrote (`dropRepeats`). For a source read whole (`RecentSync.whole`) it also drops every entry Claude sends for it, offers no `athena_health_day` for it, refuses the metrics Athena counts, and leaves its rules out of the recipe (`lifeLogPrompt`), so Claude writes only the day's line.

**Your work, counted** (recipe `work-sync`, migration `0066`, `netlify/lib/connectors/work-sync.ts`, `work-parse.ts`, `lib/work.ts`, `lib/work-stats.ts`, `lib/work-data.ts`, notes in `docs/notes/work.md`). A collection with no model, on the same footing as Plays and watches: `executeRun` hands it to `runWorkSync`, which opens each chosen Linear or GitHub account (`openConnector`) and calls its own read tools with fixed arguments through `callTool` (with `full`, so the reply isn't cut for a model): Linear `get_user` "me" and `list_issues` (assignee "me", `updatedAt`, by cursor); GitHub `get_me`, `search_pull_requests` (`author:`, `reviewed-by: -author:` and `is:merged involves: -author:`, by page) and `pull_request_read` (`get_reviews` for review counts, `get` to keep only merges whose `merged_by` is the owner). Linear can't say who closed an issue, so only issues assigned to the owner are counted. `work-parse.ts` keeps only the owner's own issues and PRs and drops everything about anyone else; a reply in a shape it doesn't know throws `ShapeUnknown` and fails that account plainly. Items go to `work_items`, one sealed value each, keyed by source and a hash of the id (`saveWorkItems`, idempotent). Per-account state in `settings` `work_sync.<id>`: newest change seen, a carry-on cursor, a lease and a wait; the first run reads back a year, later runs from yesterday's start (the late re-read). Work activity keeps Claude for notes only (what shipped, was decided, is stuck) and is no longer offered `athena_metric`. The Work page (`#/work`, `app/src/views/work.ts`, `GET /api/life/work`) and Ask's `work` read tool both shape `work_items` and Work activity's notes through `lib/work-stats.ts`. Ask reads teammates' work live from the same accounts and never imports from Linear or GitHub (`LIVE_ONLY_PROVIDERS`).

**Home** (recipe `home`, migration `0070`, `netlify/lib/home/home-run.ts`, `home-accounts.ts`). A collection with no model, on the same footing as Your activity and Your work, counted (`NO_MODEL_RECIPES` in `lib/connector-presets.ts`: the scheduler claims them and Run now starts them without AI Gateway). It reads the services whose figures Athena keeps sealed and the appliances: Octopus Energy, Monzo and Starling through `syncMoneyHome` (`money-sync.ts`: recent days replaced, a step of history, the tariff once a day, regular payments worked out again), and Home Connect through `syncAppliances` (`appliance-sync.ts`). Hourly by default. Before Home, the banks and the meter were read only inside the evening Life log run, after its check that Claude can be reached, so a run that stopped early left the day unread. A Life log now skips any bank or meter an enabled Home reads (`homeAccounts()`); with Home off or deleted it reads them again, so the accounts stay in their Life log. The 15-minute appliance look in `collect.ts` reads only the appliances an enabled Home has, and each Home run looks too: hourly alone would put a programme's end up to an hour late and could miss a short one. Migration 0070 makes one Home (hourly, due at once) from every connected Octopus, Monzo, Starling and Home Connect account when there's none, so nothing stops being read. The four presets offer Home on connect ("Read it every hour?", or "Add it to Home?": there's one Home, whatever the account's label). A run's stats are `accounts_checked`, `days_updated`, `programmes_finished` and `blocked_by`; its summary has counts of days only, per account, never an amount, a merchant or a kWh figure. Notes in `docs/notes/home.md`.

**YouTube watch history: a Google Takeout import.** The YouTube API has no
watch history, so a YouTube account's page in Sources has Import watch
history: steps for Takeout, then a file picker (the .zip, or
`watch-history.json` / `.html` on its own). The app reads the file on the
device (`lib/youtube-takeout.ts`; a zip is read in place from its central
directory by `app/src/lib/takeout-zip.ts`, so only that one entry is
inflated), drops ads, removed videos and the YouTube copy of a YouTube Music
play, groups by day in the owner's zone, and sends only each day's videos
(id, title, channel, count) to `POST /api/connectors/:id/watch-history`,
whole days at a time (up to 31 days or 2,500 videos per request). That's
smaller in transit than the file, which also holds every ad and Takeout's
markup. The server (`netlify/lib/connectors/youtube-history.ts`) folds each
day into the Life log's own day note (`collected_items` source = the Life
log collection's, external id `life-log-<YYYY-MM-DD>`), so there's still one
note per day. The import owns two sections in it, "Watched on YouTube" and
"Listened on YouTube Music"; each video's count is the larger of the note's
and the file's, so a second import of the same file changes nothing. A Life
log run that rewrites a day gets those sections put back (`keepImported` in
the runner's `athena_save_note`, for `life-log-` ids only), and its prompt
says never to write them. Days you archived or deleted are skipped. New day
notes are dated to their day (`created_at`; `updated_at` too unless the day
is in the last week), so years of history don't land at the top of Notes.
Optionally fills `videos_watched_day` (plus the label suffix) per day. No
migration.

**Health, one line a day (`lib/health.ts`, migration `0028`).** Figures
arrive two ways with one shape (`date, source, sleep_minutes, steps,
active_minutes, resting_hr, workouts[{type, minutes, distance_m, kcal,
start, name, elevation_m, route}], weight_kg, sleep_stages{deep, core, rem,
awake, in_bed, asleep_unspecified}`; the Shortcut's raw stage samples are
read and merged by `lib/sleep-stages.ts`, and the stages always come from
the same source as sleep): the iPhone Shortcut posts Apple Health's yesterday to
`POST /api/health/day` with a capture key (`netlify/lib/health/routes.ts`;
date defaults to yesterday, source to `apple_health`), and a collection with
a Strava, Oura or Withings account calls the runner's `athena_health_day`
(offered only when the run has such an account, and only for that account's
source). Both validate with `readHealthDay` and save with `saveHealthDay`:
one sealed `sensitive_blobs` row per day and source (SECURITY.md §1), merged
field by field, so a repeat changes nothing. Then the day's Life log note
gets its line, one source per figure as the owner chose in Settings → Health
(`settings` key `health_sources`; defaults sleep Oura, steps Apple Health,
weight Withings; the next source fills a gap, two are never added; resting
heart rate follows sleep), as a "Health" section at the top. Workouts are
merged: matched by kind and start within 5 minutes, the chosen source's
version with Strava's name, climb and route added; one seen once is kept.
Weight is on the line only on a weigh-in day. A Life log run that saves the
day gets the line put back from the stored figures (`keepHealthLine`, beside
`keepImported`). With no Life log yet, the save makes the day note itself
under the plain `life-log` source; a Life log with its own source adopts it
(`adoptHealthDay`), so a day stays one note. Charts read `GET
/api/health/series?field=` and the Library's Health page reads `GET
/api/health/days` (merged days, opened in the Function); `GET/PUT
/api/health/sources` holds the choices and rewrites the last 30 days' lines;
`GET /api/health/status` says which days arrived, no figures. Settings →
From your iPhone has a Health tab with the Shortcut's steps. The line's
words live in `lib/health-line.ts`, shared with the app.

**Days (`lib/days.ts`, migration `0032`).** Days replace the Life log's day notes (owner decision, 7 Nov 2026). A day is one `days` row (the run's line, which the owner can edit; mood and journal sealed together under the data key), its `day_entries` (one per thing watched, listened to, read, played, posted or saved, deduped by source and a blind index of the source's id, text sealed), and its photos (`day_files`). Health and places stay in `sensitive_blobs`; `getDay` joins them, along with that day's notes and events. A Life log run writes with `athena_day_entry` and `athena_day_line`, and `athena_save_note` refuses `life-log-` ids. The YouTube, Netflix and Goodreads imports write entries (`importToDays`, ids in `lib/day-imports.ts`), and health and places only mark the day changed. The same thing twice on one day folds into one entry. `lib/days-convert.ts` moves old Life log notes into entries and archives them (`GET`/`POST /api/days/convert`). The API is `/api/days`; Ask has a `days` tool and global search returns `day` hits. The shapes live in `lib/day-types.ts`, and the details in `docs/notes/days-data.md`. The Health and Places paragraphs above describe the old note sections, which nothing writes any more.

**The direct registry.** `direct.ts` holds one adapter per provider
(Google, Microsoft, iCloud, and the Life log ones above): `handles`, `tools`, `serverInfo`,
`open`, `authorizationUrl` and `exchangeCode` (OAuth adapters only),
`checkAddress` (address-only adapters), `accountProblem` and `failure`.
`mcp-client.ts` asks `directFor(connector)` before MCP for sign-in,
opening, listing, calling and failure mapping. Another API-only service
adds one adapter there.

**How AI-written records read.** `lib/writing-style.ts` holds `NOTE_STYLE`,
the rules for anything a model writes into Athena: plain and specific, no
em dashes, no filler words ("delve", "leverage", "pivotal"), no sum-up
closers, and quotes or source names left as they are. It goes into the
collection recipes, the Ask assistant's system prompt and the MCP server's
instructions and write-tool descriptions. `styleProblems()` checks the
mechanical part. The runner sends a note, to-do, catch-up, fact or event
note back once if it fails, and saves the second attempt as it is so a
false alarm never loses a record. The MCP server can't hold that state
between calls, so it saves the note and returns `style_issues` asking the
agent to fix it with `update_note`.

**Staying in sync.** `collected_items` maps
`(source, kind, external_id)` to the note or event a source item became. It
also records the item's date and title, and whether the collector archived
it. A run does four things with it:

- **Updates** a record when it saves the same item again.
- **Lists** what it holds for the dates it covered (`athena_list_collected`)
  and **archives** anything the source now shows as cancelled or deleted
  (`athena_archive_collected`). The recipe only allows this after fetching
  the item by id, never because it's missing from a search.
- **Restores** a record it archived if the item comes back.
- **Skips** anything you archived or deleted yourself. The mapping has no
  foreign key, so a deleted record's mapping survives and that decision is
  remembered.

With `lookahead_days` set, a calendar collection also keeps Athena's
`events` in step with the upcoming calendar (`athena_save_event`). Each
event carries `source` and, by default, `timed_push = false`, so a synced
meeting doesn't push 30 minutes before. The other people on the invite are
linked to it (edges `event → person`, relation `attendee`), found by email
first, then name. Newcomers are added to People for meetings of up to 8
others; past that only people already there are linked. Each save re-syncs
the attendee links, leaving the owner's own links alone. A meeting's note and
its synced event share the calendar event's id (`collected_items.external_id`),
so whichever is saved second links the note to the event (relation
`notes_for`), and each run starts by linking any pair that missed it
(`linkCollectedMeetings`). Metrics are one value per
`(metric, collection, day in the owner's zone)` (`replaceDailyMetric`), so reruns don't
double-count.

Custom servers get their own name and logo from their `initialize` reply's
`serverInfo` (`title`, `description`, `websiteUrl`, `icons` with light/dark
themes). If the server lists no icons, Athena uses its website's icon
instead. Either way, the logo is fetched once on the server and stored as a
`data:` URI in `connectors.server_info` (migration `0005`). See
`netlify/lib/connectors/icons.ts` and SECURITY.md §9.

Connectors are deliberately not exposed through Athena's own MCP server:
managing sign-ins is an owner action in the app, not something an agent
holding the bearer token should do.

## Artwork and day maps

Days and Watch & read show posters, book covers, album art and game headers,
and each day with places shows a map. Both are fetched once by the server and
kept, so the browser never asks a third party for an image.

- **Artwork** (`lib/art.ts`, migration `0033`): `attachArt()` takes entries
  with hints (an image address an adapter returned, a Steam app id, a
  thumbnail on the owner's Plex or Jellyfin server, an ISBN or title for Open
  Library, a film or show title for TMDB when a key is set). Images come only
  from an allowlist of hosts, are resized to two WebP sizes with an average
  tone, sealed into Netlify Blobs (`athena-art`) and recorded in `art`;
  `art_sources` maps each source to its art. Served at `GET /api/art/:id`.
- **Day maps** (`lib/static-map.ts`): the day's stops from the sealed places
  row, drawn over MapTiler or Stadia Maps tiles with the route and markers in
  Athena's colours, cached sealed in Blobs (`athena-maps`) per stops, theme
  and size. Served at `GET /api/days/:date/map`; without a key the answer is
  `{ state: "no_key" }`.
- **Keys** (`lib/art-settings.ts`): Settings → Maps and artwork keeps the
  tile key and the optional TMDB key, sealed like other secrets.
- **App**: `components/art-img.ts` and `components/day-map.ts`, for the Days
  views to place. Rules in `SECURITY.md` §13; decisions in
  `docs/notes/days-art.md`.

## AI models: which model does each job

The owner picks the models in Settings → AI models (`docs/ai-models.md`). Every
model is reached through Netlify AI Gateway.

- **Roles.** `think` (Ask, capture, every assistant's chats, runs and checks),
  `image` (pictures in chats, off by default), and the background jobs in
  `JOBS` (`lib/model-types.ts`), each in the tier `everyday` or `careful`.
- **Resolvers** (`lib/models.ts`): `resolveThinkModel`, `resolveImageModel`
  and `resolveJobModel`, highest first: the assistant's own model
  (`team_assistants.models`, migration `0077`), the owner's (a job's own, then
  its tier; the `settings` row `ai_models`), the deploy's `ATHENA_*_MODEL`
  env var, the code default. Each call reads the row and at most one
  assistant. Callers pass the result to `clientFor(ref)` (`lib/llm`); a
  background job calls `jobMessage(job, …)`.
- **Falling back.** A chosen model that fails before answering is tried once
  on the role's default (`withFallback`, `fallbackRef`). Ask's replies and
  Team runs (`team_runs.model`, `fell_back`) say which model answered.
- **The catalogue** (`lib/model-catalogue.ts`): the gateway's public list,
  kept a day in memory and in the `settings` row `ai_gateway_models`, with
  `lib/model-catalogue-snapshot.json` when it can't be read, joined with
  Athena's hand-written notes. A model with no notes has "unknown" abilities.
- **Routes** (`netlify/lib/models-routes.ts`): `GET`/`PATCH /api/models`,
  `POST`/`DELETE /api/models/consent`, `POST /api/models/test`. Choices are
  checked on the server: agreement, listed, and able to do the role.

## Security tiering

Full detail lives in `SECURITY.md`; the short version, by data sensitivity:

- **Your content: notes, people, events, to-dos and the rest** — encrypted
  at rest in Netlify DB under `ATHENA_DATA_KEY`, which only the production
  Functions hold; they decrypt as they read, so everything reachable through
  the MCP server and REST API (behind bearer-token auth) works as before. A
  dump, a backup or a deploy preview's copy of the database holds
  ciphertext. Ids, dates, kinds, statuses, `source`, the `edges` graph and
  `metrics` stay readable (SECURITY.md §11).
- **Health, location, money, home and finance figures** — stored as
  ciphertext in `sensitive_blobs.ciphertext`, sealed under the same data
  key (AES-256-GCM); there is no second scheme. Only a non-sensitive `label`
  is stored in the clear, so the table is browsable without opening
  anything. Opening happens only inside a Netlify Function holding the key
  as a secret environment variable; the key never reaches client-side/PWA
  code. `metrics` are the exception the owner chose: readable, with only a
  prompt rule keeping these figures out (SECURITY.md §1).
- **Transport and repo-level security** — the MCP server and REST API require
  the master token or an API key whose scope covers the path (capture,
  Claude only, or full; the app signs in with a full key per device); the GitHub repo stays private and holds code/schema only,
  never personal data or secrets.

## Repo layout

```
athena/
├── README.md  ARCHITECTURE.md  SECURITY.md  .gitignore  netlify.toml
├── db/
│   └── schema.sql       # rolled-up reference snapshot of the live schema
├── netlify/
│   ├── database/
│   │   └── migrations/
│   │       ├── 0001_init-schema/
│   │       │   └── migration.sql   # source of truth, applied via `netlify database migrations apply`
│   │       ├── 0002_pa-entities/
│   │       │   └── migration.sql   # places, organisations, events, archive, push
│   │       ├── 0003_people-acquaintance/
│   │       │   └── migration.sql   # people.acquaintance
│   │       ├── 0004_custom-reminders/
│   │       │   └── migration.sql   # reminders (custom, optionally repeating)
│   │       ├── 0005_pa-memory/
│   │       │   └── migration.sql   # commitments, interactions, facts, identities, suggestions, assets, reading, goals, FTS
│   │       ├── 0006_connectors/ … 0011_connector-oauth-settings/   # connectors, collections, runs, dedup, event sync, UTC times, person tags, OAuth settings
│   │       ├── 0012_encryption-at-rest/
│   │       │   └── migration.sql   # blind-index columns; drops the full-text index
│   │       ├── 0013_keep-in-touch/
│   │       │   └── migration.sql   # people.keep_in_touch: catch-up nudges become opt-in
│   │       ├── 0014_watch-and-read/
│   │       │   └── migration.sql   # reading_items kinds: film, tv, music, game
│   │       ├── 0015_trips-purchases/
│   │       │   └── migration.sql   # trips, trip_bookings, purchases, purchase_updates
│   │       ├── 0016_custom-fields/
│   │       │   └── migration.sql   # custom_fields, custom_values: the owner's own fields
│   │       ├── 0017_ask-threads/
│   │       │   └── migration.sql   # ask_threads: Ask's conversations
│   │       ├── 0018_custom-kinds/
│   │       │   └── migration.sql   # custom_kinds, custom_records: the owner's own types; edges allow 'record'
│   │       └── 0019_files/
│   │           └── migration.sql   # files (with sealed summary and words), note_files, thread_files
│   ├── functions/
│   │   ├── mcp.ts       # MCP server (Streamable HTTP)
│   │   ├── api.ts       # REST API (PWA sync + dashboard)
│   │   ├── voice.ts     # /api/voice/*: api.ts's handler, rate-limited
│   │   ├── reminders.ts # scheduled (5 min): 07:30 briefing, event + custom reminder pushes, proactive nudges
│   │   ├── collect.ts   # scheduled: claims due collections
│   │   ├── collect-run.ts # background: runs them (Claude + source MCP tools)
│   │   └── encrypt-data.ts # scheduled (5 min): seals existing rows under ATHENA_DATA_KEY
│   ├── server/          # Netlify Server: /api/assistant*, /api/talk/*, /api/live/* (docs/netlify-server.md)
│   │   ├── index.ts     # entry, config, dispatch by path. netlify.toml has no SPA catch-all rewrite, so these paths reach it
│   │   ├── routes/      # assistant.ts, talk.ts (rate limit, then api.ts's handler), live.ts
│   │   └── shared.ts    # requireAuth, rateLimit, warm
│   └── lib/
│       ├── mcp/         # MCP tool implementations shared by mcp.ts (e.g. bearer.ts)
│       ├── connectors/  # MCP client + OAuth, Gmail and Calendar via Google's APIs, runner, recipes, REST routes
│       ├── voice/       # /api/elevenlabs and /api/talk routes; picks the dictation provider
│       ├── custom-fields-routes.ts # /api/custom-fields: the owner's own fields
│       └── custom-kinds-routes.ts  # /api/kinds and /api/records: the owner's own types
├── lib/
│   ├── db.ts            # shared data-access layer (getDatabase()) — SQL lives here and in memory.ts
│   ├── memory.ts        # layer 2: commitments, interactions, facts, identities, suggestions, recall, briefs
│   ├── trips.ts         # trips, bookings and purchases, from email or added by you (server-only SQL)
│   ├── trip-text.ts     # their wording and matching keys (pure, shared with the PWA)
│   ├── carriers.ts      # tracking links built from carrier + number (pure, shared; carriers.test.ts)
│   ├── graph.ts         # the Graph page's one read: every live node and link (GET /api/graph)
│   ├── links.ts         # athena:// and web link parsing, with display modes (shared with the PWA)
│   ├── dates.ts         # time-zone-aware date maths, yearly recurrence (shared with the PWA)
│   ├── briefing.ts      # briefing wording + reminder scheduling (pure)
│   ├── reminders.ts     # custom reminder repeats + wording (pure, shared with the PWA)
│   ├── push.ts          # Web Push sending (VAPID from env)
│   ├── voice.ts         # speech to text via AI Gateway (the built-in provider)
│   ├── elevenlabs.ts    # ElevenLabs: voices, single-use tokens, Scribe, v4 Turbo speech
│   ├── voice-settings.ts # the ElevenLabs connection (one settings row, key sealed)
│   ├── connectors.ts    # SQL for connectors/collections/runs (server-only)
│   ├── connector-presets.ts # services, read-only tool lists, recipes (shared with the PWA)
│   ├── secret-box.ts    # AES-256-GCM: connector credentials, and the cipher data-box.ts uses
│   ├── data-box.ts      # encryption at rest: sealing, opening, key ring, blind indexes; sealBytes for files
│   ├── files.ts         # the file store: Netlify Blobs (sealed) + files/note_files/thread_files, blocks for Claude
│   ├── encryption.ts    # what's encrypted (ENCRYPTED, SEALED_BYTES, SEALED_SETTINGS); the backfill; status
│   ├── encrypted.ts     # the "Encrypted — open on …" placeholder (shared with the PWA)
│   ├── text-search.ts   # recall's ranking, run in the Function (stemming, OR, phrases)
│   ├── custom-field-rules.ts # the owner's own fields: kinds, types, values, safe type changes (shared with the PWA)
│   ├── custom-fields.ts # their SQL: define, rename, reorder, archive; read and set values
│   ├── assistant-fields.ts # Ask's tools for them, and their undo
│   ├── custom-kinds.ts  # the owner's own types and their records: SQL, duplicate, search (server-only)
│   ├── custom-kind-words.ts # the one place the word "types" lives (shared with the PWA)
│   ├── assistant-kinds.ts # Ask's tools for types and records, and their undo
│   ├── answer.ts        # Ask's written answers: Athena + connected accounts, checked citations (SourcesPort)
│   ├── ask-tools.ts     # Ask's read tools, shared by the answer and the assistant
│   ├── ask-context.ts   # today's block for every Ask turn (cached a minute, scrubbed)
│   ├── knows.ts         # what Athena keeps about the owner, for Settings → What Athena knows
│   └── answer-text.ts   # their shape and citation markers (pure, shared with the PWA)
├── app/                 # PWA: Home, Notes, Ask views + capture sheet
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       └── styles/
├── scripts/
│   └── export-obsidian.ts
└── .claude/
    └── agents/
        ├── calendar-meetings.md
        ├── calendar-ahead.md   # spec: the week's meetings as events, linked to people
        ├── inbox-triage.md     # spec: captures -> to-dos, facts, events
        ├── work-activity.md
        ├── email-digest.md
        └── finance.md
```

## Other ideas noted for later

Daily/weekly rollups, personal CRM nudges ("haven't talked to X in 60 days",
already supported by `listStalePeople` in `lib/db.ts`), a periodic data
health-check (stale/orphaned notes, broken links), random-note resurfacing,
and a correlated life-metrics view once enough time-series data exists in
`metrics`. None of these are built yet; they're recorded here so they aren't
lost.

## Current status

The schema, data-access layer, MCP server scaffold, REST API, PWA scaffold,
export script, and collection-agent specs described above are the system as
built. Still outstanding, each a deliberate separate decision rather than an
oversight:

- Provisioning the live Netlify DB (`netlify database init`) and applying
  migrations against it.
- Confirming whether the Netlify DB connection string is reachable outside
  Netlify's runtime (nice-to-know; the architecture doesn't depend on the
  answer either way).
- Deploying the Function API, MCP server, and PWA to production; setting the
  MCP shared secret; attaching the Athena MCP server as a connector at
  `claude.ai/customize/connectors` (needed before the three live routines
  below can actually write data — see `PROGRESS.md`); installing the PWA on a
  phone.
- Setting `SITE_PASSWORD` and `SESSION_SECRET` (see `SECURITY.md` section 6 —
  the browser-pages login gate, `netlify/edge-functions/site-auth.ts`, with
  `login-limit.ts` beside it carrying the rate limit on `POST /login`) —
  without these the edge function fails closed with a 503 rather than serving
  the site unauthenticated or unlocked.
- `calendar-meetings`, `work-activity`, and `email-digest` are registered as
  live Claude cloud routines (see `PROGRESS.md`) but can't write to Athena
  until the connector step above is done; `finance` remains unregistered.
  The owner decided on 9 Nov 2026 to turn these routines off on claude.ai
  and rotate the master token (`docs/security-review/README.md`, H2);
  collection inside Athena ("Connectors" above) is the path that stays.
- Wiring the Siri Shortcut.
