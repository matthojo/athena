# Athena — Security Model

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a
vulnerability** button on this repository's Security tab, not in a public
issue or pull request. Include what you found, how to reproduce it, and
which version or commit, and please allow time for a fix before
disclosing it.

Athena is self-hosted: each person runs their own copy with their own keys,
and the project never holds anyone's data. A fix reaches your copy when you
update and redeploy it.

---

This document is the concrete security reference for Athena: what's encrypted,
how, who can decrypt it, and what stays out of the repo. See `ARCHITECTURE.md`
for the system design this supports, and `lib/db.ts` / `db/schema.sql` for the
exact tables and functions referenced below.

There are two keys, and so two kinds of encryption at rest:

- **Your content** — notes, people's details, to-dos, catch-ups, facts and the
  rest of what you write — is encrypted in the database with a data key only
  the production Functions hold (§11).
- **Health, location, money, home and finance figures** are sealed under
  that same data key, in a table of their own, and opened only when
  something asks for them (§1). There is no separate scheme for them (§2).
- **Connector sign-ins** and your **ElevenLabs key** are sealed under their
  own key (§9, §12).

## 1. Finance and health content is sealed apart

Finance and health data is the one category in Athena that gets special
handling, because it's the one category where a leak is actually damaging.
The rule: **health, location, money, home and finance figures are stored
only as ciphertext in `sensitive_blobs.ciphertext`** (see `db/schema.sql`),
sealed under the data key (§11: AES-256-GCM, `enc:v1:`). They are not
written to a note title, a `collected_items` row or a log line.

Three things sit outside that rule, each by a decision recorded where it's
described: the Life log's Health line (below), the `metrics` table (below),
and the app's offline copy on your own device, which is plaintext like the
rest of that copy (§11 "Known limits").

Two columns on `sensitive_blobs` matter here, and they have opposite
sensitivity requirements:

- **`ciphertext`** — the sealed payload. Opaque without the data key. This
  is where the real content lives.
- **`label`** — must itself be **non-sensitive**. It exists so the table is
  browsable (list recent entries, show a timeline) without opening
  anything. A label like `"Health · 2026-11-04 · Oura"` is fine. A label
  like `"Checking: $4,281.17"` defeats the entire point of sealing the row
  and must never be written.

These rows are written by Athena's own code, never by a model: the health,
places, money and home paths below, and two that file under domain
`finance`: a receipt's fare or total (`lib/receipts-save.ts`, source
`receipts`) and Amazon order amounts (`netlify/lib/days/amazon-import.ts`,
source `amazon`). Each builds its label from the day and the source, never
a figure. No MCP tool, collection tool or route lets a caller write a
`sensitive_blobs` row directly, and `lib/db.ts` has no helper that stores
one unsealed.

**`metrics` stay readable, by the owner's choice (9 Nov 2026).** A metric's
name, value and metadata are stored as they arrive (§11). Nothing in code
keeps a health or money figure out of them. The guard is a prompt rule
only: `upsert_metric`'s description and the collection recipes tell the
model not to record one, and `createNote` is covered the same way. See
`.claude/agents/finance.md` for how the finance spec draws this line: it
writes no figures at all, only that a snapshot was taken.

The owner's own fields (custom fields, §11) aren't a way around it either:
a field named for a bank, card, password or medical detail ("Card number",
"Blood type", "Medication") is refused for every caller, the app, Ask and
MCP alike (`sensitiveLabel` in `lib/custom-field-rules.ts`), and the
field editor says to keep those details out. Values themselves can't be
policed, so the assistant's and MCP's tool descriptions repeat the rule.

### Health days (migration `0028`, `lib/health.ts`)

Sleep, steps, active minutes, resting heart rate, workouts and weight, one
day at a time, from Apple Health (the iPhone Shortcut) and from Strava, Oura
and Withings (collections, through `athena_health_day`).

- **What's sealed.** Each day and source is one `sensitive_blobs` row
  (`domain = 'health'`, plus `day` and `source`). The figures are JSON in
  `ciphertext`, sealed under the data key (§11: AES-256-GCM, `enc:v1:`). The
  label is `Health · <day> · <source name>`, never a figure. The database
  refuses a health day whose `ciphertext` isn't sealed
  (`sensitive_blobs_day_sealed`), and a write without the key is refused
  (503), never stored readable. Days and source names stay readable, so
  "which days arrived" needs no key.
- **One key.** Charts open the figures in the Function when the owner looks
  at them, which needs a key the Functions hold. The data key is
  production-only and rotates with everything else: the backfill re-seals
  health days after a rotation (§11 "Rotating the key").
- **Who can read them.** Only the Functions, for the owner:
  `GET /api/health/series` and `GET /api/health/days` (the master token or
  a full key) open a range of days for a chart or the Health page.
  `/api/health/sources` holds only which app each figure comes from. A capture key can only send a day
  (`POST /api/health/day`), never read one; its answer names the day and
  carries no figures.
- **The one exception (until Days): the Life log line.** Since migration 0032 nothing writes this line into a note: the Day reads it from the sealed rows. The owner decided (7 Nov 2026)
  that each Life log day note carries one line under a "Health" heading, like
  "7h 40m sleep · 9,200 steps · 5k run · 52 bpm resting". It's note text, so
  it's sealed like any note body (§11). Athena writes it from the stored
  figures; a collection never does (recipes rule 5), and a Health section a
  run writes itself is replaced. Weight is on it only on a weigh-in day
(owner, 7 Nov); active minutes and kcal never are. A Strava route is
sealed with the day and drawn only on the Health page, with no map.
- **What never carries them.** The `metrics` table, note titles,
  `collected_items`, run summaries (rule 9; the tool's answer has no
  figures), log lines (nothing in the health path logs a value), and Ask's
  searches and note reads, which always drop the Health line. Ask sees the
  figures only through its `health` and `days` tools (§10, "Ask's read
  tools") when the model calls one, and last night's sleep and readiness
  in today's context. Claude over MCP reads note bodies as they are, line
  included.

### Check-ins (migration `0075`, `lib/checkins.ts`)

The morning and evening check-ins' questions and answers are sealed under
the data key, one `checkins` row per day and routine; only `status` and
`done_at` stay readable, for calendars and streaks.

- **Who can read them.** Only the Functions, for the owner: a day's
  check-in (`GET /api/checkins/:date/:kind`) and, for Health → Wellness,
  `GET /api/checkins/trends`, which opens up to two years of rows in the
  Function and answers with the scale answers and the picked words and
  areas only. Written answers never leave through it. The app holds the
  trends in memory while Athena is open and never stores them on the device.

### Places and visits (migration `0031`, `lib/places-visits.ts`)

Where you went each day, from a Google Maps Timeline file and Swarm
check-ins. The owner decided (7 Nov 2026) to treat it like health.

- **What's sealed.** Visits are `sensitive_blobs` rows (`domain =
  'location'`, one per day and source: `timeline`, `swarm`, and `day` for
  the merged, named result), JSON sealed under the data key. Labels say only
  `Places · <day> · <source>`. The existing `sensitive_blobs_day_sealed`
  check refuses a readable day. A Place's coordinates, Google and
  Foursquare ids, town and visit days are one sealed value in `place_geo`
  (a check refuses anything not `enc:v1:`). Names and weather looked up
  once sit in `location_cache`, keyed by a blind index of the rounded
  coordinates or id, sealed. `location_todo` holds only dates. A write
  without the key is refused (503).
- **What stays readable.** Place names (as for every Place, §11) and which
  days have places. A Place's address is sealed like any Place's.
- **What leaves the device.** The Timeline file is parsed in the browser;
  only each visit's start, end, coordinates (5 decimals), Google place id or
  name, and Home/Work label are sent. Routes, raw signals and addresses
  never leave it. The server refuses any other field.
- **What leaves Athena.** Nominatim (OpenStreetMap) gets the coordinates of
  spots nothing else names, one request a second across Athena (an advisory
  lock), with the User-Agent `Athena-personal-notes/1.0 (self-hosted day
  log; reverse lookups cached)`: no email, account or URL. Open-Meteo gets
  the day and coordinates rounded to 2 decimals (about 1 km) of where most
  of the day was spent. Each answer is cached, so a spot or day is asked
  once. Foursquare gets only the owner's own token.
- **House's weather.** For gas allowing for the weather, Open-Meteo's
  archive and recent-past APIs get the coordinates of the Place called
  Home (its spot from visits, else its typed address looked up once through
  Places' Nominatim geocoder, which gets only the address and whose answer
  is cached sealed), rounded to 2 decimals (about 1 km), and a date range covering the
  days with gas readings, asking only for the daily temperatures. No name,
  reading, account or anything else about the owner goes with them. The
  daily means are cached a month at a time, sealed in `location_cache`
  under a blind index of `wxmean:<month>:<rounded coordinates>`, once every
  day of the month is in the archive; only the last few days are asked
  again. Without a Home Place nothing is sent and the card says why.
- **Never through Claude.** Swarm check-ins are synced by the runner itself
  (`swarm-sync.ts`); Swarm's tool is never offered to a collection's model.
  Run summaries carry counts and, when Swarm can't be read, its error
  message. A summary is sealed at rest (§11).
- **The Life log section.** Each day note gets a `Places` section: the
  place names line and the weather line. No coordinates or ids. It's note
  text, sealed like any note. A Life log run, an Ask edit and a re-import
  all keep it (`keepPlaces` through `keepImported`).
- **Ask.** Searches and note reads always drop the Places section. Ask
  sees places (names and minutes, never coordinates or ids) only through
  its `places` and `days` tools when the model calls one, and the last
  place seen today in today's context (§10). Claude over MCP reads note
  bodies as they are.
- **Rotation.** The backfill re-seals location rows and `place_geo`, and
  drops cache entries under an old key (`resealPlaces`).

### Money and home (migration `0035`, `lib/money.ts`)

- **What:** each day's spending from Monzo and Starling (amount per category, count, and each payment's merchant, local time and amount) and its electricity and gas from Octopus Energy (electricity in kWh per half hour, gas as the day's kWh, each only when the account has that meter). Half-hourly use shows when someone is home, so it is treated like location.
- **Where:** one `sensitive_blobs` row per (domain `money` or `home`, source, day), JSON sealed under the data key. House's tariff (the account's agreements and their prices) is one more sealed `home` row, source `tariff`, on a fixed day no window reads (`lib/tariff-store.ts`); it's deleted when the account number is taken off. The label is the day and the service, never an amount or merchant. Migration 0035 refuses a money or home row without a day, without `enc:v1:`, or with an amount in its label. Re-sealed by the backfill after a key rotation (§11).
- **No model in between:** a Life log run reads the banks and the meter itself before Claude starts (`netlify/lib/connectors/money-sync.ts`), the same way as Swarm. Since migration 0070 they're read by the Home collection, hourly, with no model at all (`netlify/lib/home/home-run.ts`, the same `syncMoneyHome`); a Life log reads a bank or meter only when no enabled Home does. Their tools are never offered to Claude, so a collection never sees amounts or merchants, and they never reach an entry, note, metric, log line or run summary. The summary says how many days changed and, when a bank or the meter can't be read, that service's error message; it is sealed at rest (§11). A payment nudge is claimed in `reminder_log` under a blind index of the merchant (`pay-up:<index>:<date>`, `pay-missed:<index>:<date>`), never its name; without the data key there is no index and no nudge. After a key rotation a nudge can repeat once, if the old key is removed before the reminders run has seen that nudge again. Amounts and merchants reach a prompt only when the owner has turned on "Let Ask read transactions" and Ask calls a money tool (below). Life log runs still never see them.
- **Read-only:** Monzo is read with the owner's own confidential OAuth client; Starling with a personal token scoped to `account:read transaction:read`; Octopus with its API key. Octopus's account stores, in the connector's `url`, only the meter numbers (MPAN and serial, MPRN and serial, and whether gas is in m³); the key is sealed with the other connector secrets. Athena sends Octopus only the key (as Basic auth) and GETs to each meter's consumption endpoint. "Find my meters" sends the account number the owner types, with the key just pasted or the account's own, in one GET to `/v1/accounts/{number}/`; Athena keeps only the import meter points and serials of the current home from the reply (never the postal address, tariffs or export meters), returns them to the form, and stores nothing until the owner saves. The account number is optional and kept only on the connector's `url` (`?account=A-XXXXXXXX`), never in a note or log. With it, the meter sync reads House's costs once a day: one GET to `/v1/accounts/{number}/` with the key, keeping only each read meter point's agreements (tariff code, from, to); then, **without** the key, GETs to each tariff's public `standard-unit-rates`, `day-unit-rates`/`night-unit-rates` and `standing-charges` under `/v1/products/{product}/`, which carry only the product and tariff codes and a date window. Nothing about consumption is sent. The meter history (24 months, a month a request, on connect and in each Life log run) and the prices (25 months) use the same endpoints with earlier dates. The run summary says only "tariff read". No balance is read or shown anywhere, and nothing moves money. A purchase matched to a payment gets no amount: the payment keeps the purchase id inside the sealed row.
- **Who sees it:** Days show the money and home lines only after the owner turns each on (Settings → Days, off by default, stored server-side). Ask is separate: "Let Ask read transactions" (Settings → About you, off by default, stored server-side as `ask_money`, independent of the Days switch). While it's off, `money` and `regular_payments` aren't offered to the model at all, a call to either is refused before anything is read, a day read in full leaves its spending and electricity out, and a spending question gets "Money search is off" with a link to the switch. Since Ask became one loop (12 Nov 2026) no word rule in front of the model decides what a spending question is: the model, which has no money tool to call, sets `needs_money`, and the reply's words are then the fixed line from code, not the model's. That is one model call, which sees the question and nothing of the bank data. While it's on, amounts and merchants reach a prompt only when Ask calls one of those tools, or reads a day in full. Today's context never carries money either way. Patterns use eating-out spend and evening electricity only while the matching switch is on. The Library's House page (`GET /api/life/house`) needs full access, like Money: it opens the home days, the tariff and the regular payments in the Function and returns chart figures, costs and household bills; a capture key can't read it.

### Days (migration `0032`, `lib/days.ts`)

- **Mood and journal** are one JSON value in `days.private`, sealed under the data key. A check refuses anything not `enc:v1:`, a write without the key is refused (503), and the backfill re-seals it after a rotation. Ask reads them only through its `days` tool, for one day in full or a search, when the model calls it. Global search never reads them; the owner's own Days search does.
- **The line and entries** are sealed like note text (§11): title, subtitle, link, group, note and the source's own id. Dedupe matches a blind index of the source's id (`ext_key`). Kind, source, dates, rating, count and minutes stay readable for counts and the calendar.
- **Health and places are never copied into a day.** `getDay` opens them from `sensitive_blobs` when asked. Ask's `days` tool opens them for one day in full, and a run's `athena_day_read` never gets them. Workouts are shown as entries, opened each time and never stored.
- **Photos** are files (§11 "Files"), linked through `day_files` and kept while a day uses them.
- **Cover art** is stored and served by days-art's `lib/art.ts` (`GET /api/art/:id`); a Day entry keeps only its `{ id, w, h, tone }`.
- **Places as entries:** a day's named stops (names and minutes, never coordinates or ids) are written as `day_entries` with source `places`, sealed like any entry. They're read only where places are allowed (`getDay`'s `places`, Ask's `days` and `places` tools, the owner's own Days search). Global search, a run's `athena_day_read` and Ask's searches never see them.
- A capture key can't read a day.

## 2. One scheme for everything

Finance and health rows use the same cipher and the same key as the rest of
Athena: AES-256-GCM under `ATHENA_DATA_KEY` (§11 "How it works"). No code
uses `age`, and there is no key pair to make or keep. The owner decided
(9 Nov 2026) to leave it that way.

- **Sealing and opening happen only in the Functions**, which read the key
  from their environment. The key never reaches the app or any other
  client-side code. A page that shows health or money figures calls a route
  that opens them on the server and returns them over authenticated HTTPS.
- **Rotation** is the data key's (§11 "Rotating the key"): the backfill
  re-seals `sensitive_blobs` with everything else, and the status counts
  those rows.
- **What that means.** Anyone who can read both the production environment
  and the database can open these rows, as with all other content (§11
  "What it doesn't").

## 3. Public code, private instances, and secrets hygiene

- **The code can be public; nothing in this model depends on it being
  secret.** Each copy of Athena is its own Netlify site with its own
  database and its own keys. The protection is the keys, not the code: the
  data key and connector key (§9, §11), the master token and API keys (§5)
  and the site password and session secret (§6) are generated per site and
  live only in that site's Netlify environment. Reading this repository
  tells an attacker how the locks work, not how to open anyone's.
- **The repository holds no one's data.** Sample mode, fixtures and tests
  use made-up people, addresses and numbers (UK numbers from Ofcom's
  drama range, `07700 900xxx`; addresses on example streets). A real name,
  email, address, account number, calendar name or screenshot of a real
  account never goes into code, a fixture, a doc or a commit message.
- **No production address is built in.** Where the code needs the site's
  own address it reads Netlify's `URL` variable, and the browser extension
  asks for it. Examples use `athena.example.com`.
- **Report a vulnerability privately** ("Reporting a vulnerability" at the
  top of this file), not in a public issue.
- Only `.env.example` (placeholder values, safe to commit) belongs in the
  repo. `.env` (real values) is git-ignored — see `.gitignore`. This applies
  to every secret the project uses: `MCP_BEARER_TOKEN`, `ATHENA_DATA_KEY`,
  `CONNECTOR_ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY`, any AI provider key the
  owner sets (§10), any embeddings-provider API key, and the Netlify DB connection string if it's ever materialized locally
  for the export script.
- Real embeddings and API keys must never be committed, including inside
  fixture data, test files, or commit messages.

## 4. Netlify DB access

Row-level access to Netlify DB is managed through Netlify account roles —
only a Team Owner is issued the full read-write connection string. As noted
in `ARCHITECTURE.md`, as of the last check Netlify's own documentation did not
confirm whether that connection string is reachable from outside Netlify's own
runtime at all. Rather than assume either way, Athena's access pattern is
split cleanly in two:

- **Everything except the Obsidian export** goes through Netlify Functions,
  using `lib/db.ts`'s `getDatabase()` (`@netlify/database`) — Netlify's
  documented, supported access path *from inside* its own runtime. This is
  the MCP server, the REST API, and (eventually) the scheduled collection
  agents.
- **The Obsidian export script** (`scripts/export-obsidian.ts`) is the one
  deliberate exception. It runs as a plain Node script outside Netlify
  Functions, so `getDatabase()`'s automatic environment detection doesn't
  apply. For that case, Netlify documents a second pattern explicitly meant
  for use outside its runtime:

  ```ts
  import { getConnectionString } from "@netlify/database";
  import pg from "pg";
  const pool = new pg.Pool({ connectionString: getConnectionString() });
  ```

  This is safe specifically because it's the documented external-access
  pattern, run locally by the Team Owner with the full connection string
  already in their environment — not a workaround, not a second undocumented
  path. No other part of the system should use `getConnectionString()`
  outside of this script.

  What it reads is encrypted (§11), so it also needs `ATHENA_DATA_KEY` in
  that shell, read from your Keychain for the one run; without it the export
  contains placeholders. The vault it writes is plaintext on your disk.

## 5. MCP server and REST API authentication

Both the Athena MCP server (`netlify/functions/mcp.ts`) and the REST API
(`netlify/functions/api.ts`) require a credential on every request but
three: `GET /api/health` (it answers `{ ok: true }`, so the app can tell it
is online), `OPTIONS` preflights, and the OAuth callback, which its
single-use `state` authenticates (§9). The first credential is the master
token, read from the `MCP_BEARER_TOKEN` environment variable.

- **Generation**:

  ```sh
  openssl rand -hex 32
  ```

- **Storage**: set as a Netlify secret environment variable
  (`netlify env:set MCP_BEARER_TOKEN $(openssl rand -hex 32) --secret`), never
  committed, never placed in `.env` (only `.env.example` with a placeholder
  belongs in the repo).
- **Comparison**: the incoming `Authorization: Bearer <token>` header is
  compared against `MCP_BEARER_TOKEN` using a timing-safe equality check
  (e.g. Node's `crypto.timingSafeEqual`, applied to equal-length buffers —
  never a plain `===` string comparison, which leaks timing information about
  how many leading bytes matched).
- **Logging**: the token itself must never be logged — not in request logs,
  not in error messages, not in Netlify Function logs. Log the fact that
  auth succeeded or failed, never the value compared.

Everything else that calls the REST API or MCP presents the master token,
or an **API key** the owner made in the app (Settings → API keys,
`lib/api-keys.ts`, checked by `authorized()` in `netlify/lib/mcp/bearer.ts`).
Keys exist so that nothing but the owner ever holds the master token. Where
a later section says "the bearer token", it means the master token or a
full key.

| Credential | `/mcp` | `/api/*` | Capture paths | `/api/api-keys` |
|---|---|---|---|---|
| Master token | yes | yes | yes | yes |
| Full key (`athk_…`) | yes | yes | yes | 403 `master_required` |
| Claude only key (`athm_…`) | yes | 401 | 401 | 401 |
| Capture key (`athc_…`) | 401 | 401 | yes | 401 |

- **Capture only** (`athc_…`): for an iPhone Shortcut (Siri, the share
  sheet), which syncs through iCloud, and the browser extension. It opens
  four things and nothing else: `POST /api/assistant/capture`,
  `POST /api/saved` with `GET /api/saved/ping`, `POST /api/health/day` and
  `POST /api/habits/log`. It files; it can't look anything up ("What a
  capture can do", below).
- **Claude only** (`athm_…`): Athena's MCP tools at `/mcp` and nothing
  else. Every `/api/*` path refuses it, so it can't delete for good, list
  archived items, or reach connectors, files or keys (§7). This is the key
  to give Claude, or any MCP client, as a connector.
- **Full access** (`athk_…`): REST and MCP, like the app: for a device the
  app is signed in on, and the owner's own scripts. On REST that includes
  permanent delete and the archived list (§7).
- **Managing keys takes the master token.** Listing, making and removing
  keys (`/api/api-keys`) answers `403 master_required` to any key, so a
  leaked key can't mint itself a replacement. Settings → API keys asks for
  the token once per visit and holds it in memory only. The one exception:
  any key can remove itself (`DELETE /api/api-keys/self`), which is how
  Sign out gives up a device's key (§6). At most 20 keys exist at once,
  device keys included.
- **The app signs in with a key of its own, one per device.** On Connect
  the owner pastes the master token once. The app sends it in a single
  `POST /api/api-keys`, stores the full key that comes back (labelled with
  the browser and device, like "Athena app, Safari on iPhone") and drops
  the token. A pasted full key is stored as it is; a capture key is turned
  away. An install that still holds the master token swaps it for a key the
  next time it opens online. The key sits in the browser's `localStorage`.
  Removing it in Settings → API keys signs that device out.
- **Storage:** a key is shown once, when it's made, and stored only as a
  SHA-256 hash in `settings.api_keys` (compared in constant time). Each
  records when it was last used. Removing one stops it straight away, and
  doesn't affect the others or the master token.
- **Scheduled collection runs** (`/api/collect-run`) still need the master
  token, since only Athena's own scheduler calls them.

### What a capture can do

- **Five filing tools.** `/api/assistant/capture` runs the model with
  `save_note`, `add_todo`, `add_reminder`, `add_to_list` and
  `add_to_watch_read` only (`CAPTURE_TOOLS` in `lib/assistant.ts`).
  `captureGuard` runs before every tool call and refuses any other tool,
  and any `note_id`, `person_id` or `about_id`, so a capture can't read,
  can't overwrite a note and can't reach a record.
- **Nothing to read from.** A capture session has no mail, Slack, calendar
  or scheduling port, whatever the caller sends, and gets no owner profile,
  no context about today, no past chats, no `@` mention lookup and no money
  setting.
- **A fixed reply.** The answer is a line built in code from which tools
  ran ("Added a to-do.", "Added 2 to-dos and a reminder."), never model
  text and never a title. The JSON form (`?format=json`) adds each change's
  kind and id. When nothing is filed, or the assistant fails, the text is
  kept as an inbox note ("Saved to your notes to sort later.").
- **Links and images go to Saved.** Text that is or starts with a link, or
  a shared image, is saved as a Saved item instead (§11 "Saved"), with no
  model involved. That reply names what was saved by its title, which for
  a link is the page's own.
- **The other capture paths.** `POST /api/health/day` answers with the
  day's name only (§1). `POST /api/saved` answers with the item it just
  stored: what was sent, plus what Athena read from that link's page.
  `POST /api/habits/log` answers with the matched habit's name and count,
  and its errors never list habit names. None of them can list or look up
  anything else.
- The capture path sits behind the assistant's rate limit (20 a minute,
  counted by the Netlify Server).
- **A capture never attaches a person.** Finding one is a read. The app
  offers the link afterwards: an open to-do with nobody linked, whose title
  names someone in People, shows "Link to" and their name in To do and in
  its sheet, and one tap links it. `GET /api/todo-people` and
  `POST /api/todo-people/:id/dismiss` need the app's key or a full key; a
  capture key gets 401.
- **The live channel.** `GET /api/live/events` (Netlify Server) needs the
  master token or a full key, sent in the `Authorization` header like every
  other call: no token in a URL and no ticket. Its events carry a kind, row
  ids and an opaque mark, never titles or text; the app fetches the content
  through `/api/*` as before. At most 8 streams are open at once and 30
  connections a minute per IP are accepted.

## 6. Site-wide login (browser pages)

`/api/*` and `/mcp` are gated by the bearer token above, but the static PWA
shell itself (`/`, the JS/CSS bundle, the manifest) has no auth of its own —
anyone with the URL can load it. `netlify/edge-functions/site-auth.ts` closes
that gap for the browser-facing pages only, **without** touching `/api/*` or
`/mcp`'s existing bearer-token path.

This is deliberately not Netlify's built-in site-wide password protection:
that feature applies interactive Basic Auth at the edge to every request,
including `/api/*` and `/mcp` — which would lock out the Athena MCP
connector, Shortcuts and scripts, since they only ever send
`Authorization: Bearer <token>`, never Basic Auth credentials.

- **Password**: one shared secret, `SITE_PASSWORD`, set the same way as
  `MCP_BEARER_TOKEN` (`netlify env:set SITE_PASSWORD ... --secret`, never
  committed). Single-user personal app, so there's no user table — this is
  the same password every time, compared with the same timing-safe pattern
  as the bearer token (equal-length check before a constant-time byte
  comparison).
- **Session**: a successful `POST /login` issues a cookie —
  `athena_session=<expiry-epoch-seconds>.<base64url HMAC-SHA256 of the
  expiry>` — signed with a second secret, `SESSION_SECRET`, generated the
  same way (`openssl rand -hex 32`) but stored separately from
  `MCP_BEARER_TOKEN` on purpose: the master token is typed outside this
  system (Connect on each device, Settings → API keys, a script), while the
  session secret never leaves the edge function, so a leaked token or key
  alone can't forge a browser session.
- **Cookie flags**: `HttpOnly` (unreachable from page JS, so it can't be
  exfiltrated via XSS), `Secure` (HTTPS only), `SameSite=Strict`, 30-day
  expiry. No server-side session store — the cookie itself is the credential,
  the same tradeoff the bearer token already makes.
- **Ungated static paths**: besides `/api/*` and `/mcp`, only `/fonts/*` and
  `/icons/*` pass through without a session — the login page needs its
  typefaces and favicon before you've signed in, and neither contains
  anything about you. Everything else (the app bundle, the manifest, the
  service worker) stays behind the cookie at the network. On a device that
  has opened the app before, the service worker serves its cached copy of
  the bundle without the cookie. What that can show is the offline copy
  already on the device; anything from the server still needs the device's
  key (§5).
- **Fail closed**: if either `SITE_PASSWORD` or `SESSION_SECRET` is unset,
  the edge function returns `503` for every browser page rather than falling
  back to serving the site unauthenticated.
- **Login attempts are rate limited.** `POST /login` has a platform rate
  limit of 10 requests a minute per IP
  (`netlify/edge-functions/login-limit.ts`). Netlify answers 429 past it,
  before any code runs, and can take up to 10 seconds to start blocking.
  The limit is enforced by Netlify's edge, so it has only been checked by
  reading the rule, not on the live site. The password is the owner's own
  choice (`.env.example`), not a generated one, so its strength is theirs
  to keep.
- **Sign out removes everything Athena keeps on that device**
  (`app/src/db/sign-out.ts`): the push subscription (on the server and in
  the browser), the device's own key on the server
  (`DELETE /api/api-keys/self`), `localStorage` and `sessionStorage` (the
  key, drafts, names, the share switch), the offline databases, every
  `athena-*` cache (opened files, art, maps, a waiting share) and the
  service worker. Then `/logout` clears the session cookie. Each step is
  best effort and none stops the rest: offline, the key stays valid on the
  server until it's removed in Settings → API keys.
  When changes haven't been sent yet, Sign out warns first and offers to
  send them. The worker doesn't handle `/logout`, so the page Sign out
  lands on isn't written back into a cache.
- **Not covered**: sessions can't be revoked one by one (the cookie is the
  credential until it expires), and the only content security policy the
  app sets is `frame-src`.

## 7. Archive vs delete

The owner's rule: Claude and other agents get full create/edit control over
Athena **except delete**.

- **The rule is the MCP server's.** It holds for a Claude only key (§5),
  which reaches `/mcp` and nothing else. A full key also reaches REST,
  where permanent delete and the archived list are, so give an agent a
  Claude only key and keep full keys for the app's devices and your own
  scripts. A full key Claude was given before still works on both until
  the owner removes it.
- **An edit can overwrite, so every edit to a note keeps a version**
  (`note_versions`, migration `0061`, `lib/note-versions.ts`). When a
  change alters a note's title or body, what it replaced is kept first,
  still sealed, whoever made the change: MCP, Ask, a collection, a script
  or the app. The newest 20 per note are kept. The owner's own typing in
  the app is grouped: it keeps a version only when the note's newest
  version isn't one of their own from the last 10 minutes. "Earlier
  versions" in a note's ⋯ menu lists them, says who made each change, and
  restores one (`GET /api/notes/:id/versions`,
  `POST /api/notes/:id/versions/:version/restore`, master token or full
  key); a restore keeps what it replaced as a version too. Versions go
  when the note is deleted for good. Other kinds of record keep no
  history.

- **Archive** (`archived_at` set) is the only way an agent can remove
  something. MCP has `archive` and `unarchive` tools that work on any kind
  by id. Archived items are filtered out of every read path — lists, search,
  Home, Ask, counts, Coming up, reminders, the morning briefing, MCP
  list/search/get, backlinks and the Obsidian export.
- **Custom reminders** aren't archivable entities. MCP and Ask can create,
  list and change them, and "remove" one only by marking it done
  (MCP's `update_reminder` with `done: true`, Ask's `archive_or_restore`);
  `DELETE /api/reminders/<id>` is the app's own action.
- **There is no delete tool and no archived listing in MCP.** An agent can't
  enumerate what's been archived, and can't destroy anything; the worst a
  misbehaving agent can do is archive things, which the owner can restore.
- **Permanent delete is a manual action in the app only**, from an item's
  overflow menu or the Archived page, behind a confirmation. It goes through
  `DELETE /api/<kind>/<id>` (the master token or a full key; the app is the
  only client Athena ships that calls it). It removes the row, its custom field
  values and every `edges` row referencing it in a single SQL statement (so
  atomically); deleting a person also deletes their birthday event and its
  edges.
- `GET /api/archived` exists for the app's Archived page. It takes the
  master token or a full key; a Claude only or capture key gets 401.
- Clearing a person's birthday through `upsert_person` archives their
  birthday event rather than deleting it, so even that path can't destroy data.
- **Delivered purchases** are archived by Athena itself 30 days after they
  arrive (or are returned, refunded or cancelled), never deleted. They're on
  the Archived page; one you restore stays, and a later email about the same
  order (a return, a refund) brings it back. Trips, single bookings and
  purchases archive and restore like every other kind, from the app or MCP.
- **Trips and orders you add** (the forms, or Ask) carry `source: "manual"`.
  The email collection only adds to one, never overwrites or archives it:
  `saveBooking` fills a manual booking's empty fields only (never its name,
  times, status or reference), except that a cancellation email always
  marks it cancelled, with that email's link in `cancel_email_link`
  (sealed); `savePurchase` moves a manual order's
  status forward and sets carrier and tracking, never its shop, items,
  order number or days. That holds whether it's matched by reference,
  order or tracking number, or named by id; an accepted Review-inbox
  suggestion goes the same way. Fields you edit on any booking or order
  (`owner_edited`, field names only, migration 0020) are skipped by later
  emails. Settled orders you added are not auto-archived. The collector
  has no delete or archive tool for them. A new email booking may
  still join a trip you added; the trip's name, notes and dates stay yours
  (its dates only stretch to hold the booking). Tracking links are only
  built (`lib/carriers.ts`); Athena never fetches anything from a carrier.
- **Ask's conversations** (`ask_threads`, migration 0017) are the app's
  alone: not in MCP, so no agent can read, archive or delete them. Archiving
  one from Ask is part of saving it (`archived_at`); the Archived page lists
  archived conversations from the device, restores them, or deletes one for
  good behind a confirmation (`DELETE /api/ask-threads/<id>`). A
  conversation keeps what was said and the assistant's replies; search
  answers and written answers keep Athena's notes, people and to-dos only by
  id, never a copy of their text.
- **The owner's own types and their records** (`custom_kinds`,
  `custom_records`, migration 0018) follow the same rule. Ask
  (`archive_or_restore` with kind `type` or `record`) and MCP (`archive` /
  `unarchive` with kind `kind` or `record`) can archive and restore a type or a record, never
  delete one; there's no delete tool for either. Archiving a type hides its
  records and fields with it and keeps them all. Permanent delete is on the
  Archived page only (`DELETE /api/kinds/<id>`, `DELETE /api/records/<id>`),
  behind a confirmation that says what goes: for a type, how many records,
  with their notes, values and links, and its fields. Deleting a type
  removes its records, their edges and values, and its fields and their
  values in one statement.

## 8. Push notifications

- **VAPID keys.** When `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set
  as Netlify environment variables (the private key with `--secret`) they
  win (GUIDE "Notification keys (VAPID)" sets them without printing the
  private half). Otherwise Athena makes its own pair the first time push is needed and
  keeps it in the `settings` row `vapid`: the public key readable, the
  private key sealed under the data key (§11, `enc:v1:`), never logged or
  returned by the API. Without the data key it makes nothing and push is
  skipped. A pair sealed under an older key is re-sealed by the backfill
  after a rotation (§11) or on its next use, whichever comes first; one
  that no longer opens is replaced, and each device moves to the new key the
  next time the app opens. The public key is not secret and is served by
  `GET /api/push/key` (behind the same bearer token as the rest of the API).
- **Choices** (Settings → Notifications) are switches and clock times in the
  `settings` row `notifications`, nothing personal. The evening prompt's body
  names one thing from the day (an entry or event title), never health or
  places.
- **Subscriptions** (`push_subscriptions`) hold each device's push endpoint
  and encryption keys. An endpoint is effectively a capability to notify
  that device, so it is never logged; failed sends log only the status code.
  Endpoints the push service reports as gone (404/410) are deleted.
- **Which endpoints are accepted** (`pushEndpoint` in `lib/push.ts`). Only
  https on a known push service: `fcm.googleapis.com`,
  `updates.push.services.mozilla.com`, `*.push.apple.com` or
  `*.notify.windows.com`, on the default port, with no user or password.
  The subscribe route refuses anything else (400), and a stored row that
  fails the check is removed without being sent to. At most 10 are kept; a
  new device past that replaces the one unused longest. Each row records a
  fingerprint of the token or key that registered it (never the token),
  and before every send, rows whose credential is no longer the master
  token or a current key are deleted. So removing a key, signing a device
  out or changing the master token stops that device's notifications, and
  a row from before this rule is deleted on the first send; the device
  subscribes again from Settings → Notifications. A send times out after
  10 seconds.
- **Payloads** are encrypted end to end by Web Push (aes128gcm) and contain
  only a short title, a one-line digest and an in-app link. The service
  worker only opens same-origin `/#/…` routes from a notification, never an
  arbitrary URL.
- **Idempotency**: every send is guarded by a `reminder_log` key claimed
  before sending, so retries or overlapping runs can't notify twice.

### Nudges Athena starts (migration `0051`, `lib/proactive/`)

- **What's stored.** One `nudges` row per nudge. Its title, body, evidence,
  context, suggested reply, names, email subjects and snippets are in
  `payload`, sealed under the data key (§11). Readable columns hold only the
  rule, a dedupe key made of ids and times (`prep:<event id>:<start>`,
  `reply:<thread id>:<sent at>`; a habit drift nudge's key also holds the
  habit's name, `drift:<source>:<habit name>:<day>`), the day, and when it was pushed, opened,
  dismissed or applied. `nudge_mutes` holds a rule name and a time. The
  switches are the `settings` row `proactive`: booleans and two numbers.
- **What a push carries.** The title and body only, plus `/#/ask/nudge/<id>`.
  They never include what someone wrote (no subject or snippet), health
  figures, or where the owner has been: meeting prep says counts ("2 open
  to-dos, 1 recent email"), the day plan says "An easier start today?"
  without saying why, and leave by names the event's Place and the minutes.
  Those details are only in "Why am I seeing this?", which loads from the
  API behind the bearer token.
- **Mail.** Awaiting reply reads sent mail through each connected mailbox's
  own read-only `search_threads` (latest message per thread), at most once an
  hour, in working hours, with the owner's mail rules applied by that tool.
  Nothing from a thread is kept unless a nudge is made, and then it's sealed.
- **Nothing is sent on the owner's behalf.** After a meeting and awaiting
  reply open Ask with a suggested request for a draft; drafts go through the
  existing draft flow (§10). The day plan moves events only when the owner
  taps a move, through `/api/scheduling/move` with Undo, and the weekly plan
  changes a to-do's due date only when the owner taps Apply.
- **Health and Patterns in the evidence.** Drift may quote the habit's own
  line from Patterns ("You sleep 30 min longer on days you go to the gym")
  and say no workout was logged; the day plan's evidence names last night's
  sleep. Those lines are only in the sealed payload and "Why am I seeing
  this?". The briefing's lighter-plan section and its push never say why.
- **Location.** Leave by reads the day's sealed visits and the Place's sealed
  coordinates or address in the function. Neither spot is stored with the
  nudge; the evidence names the town at most.
- **Live directions** (`netlify/lib/proactive/directions.ts`). When both
  spots are in London and there's a TfL key, Athena asks TfL's Journey
  Planner. Elsewhere, with a Google Maps key, it asks Google's Routes API.
  Keys come from Sources, or else the environment (§15).
  - What's sent: the two coordinates (5 decimal places) and the arrival time,
    plus the key. TfL gets its key as `app_key`; Google gets it in the
    `X-Goog-Api-Key` header. No name, address, event title or person is sent.
  - When it asks: only for the next event at a Place, within 90 minutes of
    it, at most once per 5-minute run.
  - Caching: a TfL answer is kept for 10 minutes, and a Google answer until
    the event starts, so Google is asked once per event. A drive is asked
    once more, with the same two coordinates, when its leave time is 30 to
    15 minutes away (`recheckDue`), so Leave by's nudge has the traffic near
    the time; never a third time. Both live in the `settings` row
    `leave_by_route`, holding the event id and start, minutes, mode, source
    and whether it was rechecked, with no coordinates.
  - Keys are sealed connector credentials or environment variables (§15),
    never logged; failures log only the host and status.
  - With neither key, nothing leaves Athena and the nudge uses a distance
    estimate, which "Why am I seeing this?" labels as one.
  - How the owner travels (`travel_mode`, and `travel_by_event` by event
    id, in the `settings` row `proactive`; no place, time or title) picks
    the request: on foot and by bike go to TfL in London (`mode=walking` or
    `cycle`) and Google elsewhere (`WALK`, `BICYCLE`). A drive only ever goes
    to Google (`DRIVE`, `routingPreference: TRAFFIC_AWARE`, leaving now, no
    arrival time); TfL never hears about it. Without a Google key nothing is
    sent for a drive: the nudge has no time and says how to add the key. It
    is never timed as public transport. Each way of travelling has its own
    cache entry.

## 9. Connectors (accounts Athena signs in to)

Athena holds credentials to other services so its scheduled collections can
read from them: OAuth access and refresh tokens, and API keys. These are the
most powerful secrets it stores — a Gmail refresh token reads your email — so:

- **Sealed at rest.** Every credential for an account (token, OAuth client
  secret, dynamic registration, access/refresh tokens, PKCE verifier) is one
  JSON object sealed with AES-256-GCM (`lib/secret-box.ts`) into
  `connectors.credentials`. The key is `CONNECTOR_ENCRYPTION_KEY`, a Netlify
  secret environment variable (`openssl rand -hex 32`), never committed. A
  database dump or the Obsidian export reveals nothing usable. The key
  lives only in the Functions environment, because the unattended collector
  has to decrypt on every run. Without it, adding accounts is refused rather
  than storing anything in the clear. Rotating it makes stored sign-ins
  unreadable: sign each account in again.
- **Never sent back out.** The API returns an account's status, tools and
  *whether* a token or own OAuth client is stored, never the values. Nothing
  is cached on the device. Credentials are never logged.
- **Reusing your own client stays on the server.** A new account can take
  another account's own OAuth client (`client_from` on
  `POST /api/connectors`): the server opens the source's sealed blob and
  seals the client ID and secret into the new account's, and nothing else
  is copied (no tokens). Only within one family: Google with Google,
  Microsoft with Microsoft (the presets' `ownClientLabel`); anything else is
  refused. The app only ever sees which account it would copy from, by id
  and name (`setup.own_clients`). Each copy is then independent: rotating
  the secret on one account doesn't change the others.
- **Read-only, enforced in code.** Each account has an allowlist of tools.
  Tools are classified when listed (`lib/connector-presets.ts`): a preset's
  known read tools, or a hosted preset server's `readOnlyHint`, mark a tool
  read-only; anything named like a write (send, reply, label, archive,
  delete, create, update, …) or annotated destructive is a write and
  **can't be allowed**, by the default or by the owner. A custom server's
  `readOnlyHint` isn't believed (next point). Only a preset's known read
  tools, and the reads of Athena's own direct adapters, start allowed;
  every other tool starts off until the owner allows it. At run time the allowlist is re-checked,
  the model is only shown allowed tools, and a call to anything else is
  refused before it reaches the server. Where the provider supports it,
  presets also request read-only OAuth scopes (Gmail `gmail.readonly`,
  Calendar `calendar.readonly`), so the token itself can't write.
- **Custom MCP servers are kept apart and pinned** (migration `0060`). A
  custom server is one the owner added by address, not a preset.
  - **Every tool starts off**, whatever the server says about it. A tool it
    marks read-only is listed under "Might change things" until the owner
    reads it and allows it.
  - **Pinned.** When the owner allows a tool, Athena keeps a SHA-256 of its
    description and input schema (`connectors.tool_pins`). Every run and
    every Ask answer lists the server's tools again, and a tool whose text
    no longer matches its pin is left out of the model's tool list until
    the owner approves the new text on the account's page ("Changed, needs
    re-approval"). "Check connection" never approves. Hosted presets aren't
    pinned (owner, 10 Nov 2026). A server connected before pinning is
    pinned at the text it has on its next listing.
  - **Out of Ask** unless the owner turns on "Use in Ask" for that server.
  - **In a collection of its own** unless the owner turns on "Share
    collections". Saving a collection that puts such a server beside any
    other account is refused, and a run leaves it out. So nothing it says
    reaches a run that also reads your mail or calendar.
  - Both switches are off by default, including for servers connected
    before they existed.
  - **Tool text is capped** for every remote MCP server, preset or custom:
    900 characters of description, 300 for each description inside the
    schema, and a schema still over 8,000 characters is replaced by "any
    object".
- **Athena's own writes are a fixed list.** A collection writes through
  about twenty Athena tools (`netlify/lib/connectors/runner.ts`): notes
  (always tagged with its own `source`), find-or-create people, projects
  and organisations, links between records, metrics (names suffixed with
  its label), to-dos, details to remember, catch-ups, events, trip
  bookings, purchases, receipts, watch & read items, health days, and a
  day's line and entries. It can read back what it collected, search notes
  and read a day. It has no delete tool, its one archive tool is limited
  as described under "Archive, never delete" below, and each run has caps
  on turns, time, notes and metrics.
- **Docs and pages the owner sends are the other writes.** A note sent to
  Google Docs or Notion makes a new doc or page and nothing else, and only
  what Athena made can be changed later ("Documents Athena writes" below).
- **Answering invites is the one calendar write, and it's opt-in.** With
  "Let Athena answer invites" on for a Google Calendar, Outlook or iCloud
  Calendar account (`RSVP_SCOPE` in `lib/connector-presets.ts`:
  `calendar.events` or `Calendars.ReadWrite`, asked for only then; iCloud
  has no scopes, so it's Athena's own marker), Athena sends your Going,
  Maybe or Declined (`lib/rsvp.ts`) and nothing else: Google's attendee
  patch with only you in it (`attendeesOmitted`), Graph's `accept`,
  `tentativelyAccept` or `decline`, or iCloud's PARTSTAT change below. `google-api.ts` and `microsoft-graph.ts`
  check the exact URL and body shape and refuse any other write, so no code
  path creates, edits, moves or deletes an event. `respond_to_event` is
  classed as a write, so collections and Ask's sources never see it;
  `callTool` refuses it without the switch, on an MCP server, and refuses
  every other write on a direct account. Without the switch the answer
  stays in Athena.
- **Adding events, and moving events you organise, are a second calendar
  write, also opt-in, with their own switch.** See "Adding and moving
  events" below.
- **Only the email the owner's rules allow is read.** Gmail and Outlook
  accounts can carry rules (`lib/mail-rules.ts`): inbox only, skipped
  senders and domains, subject phrases and labels or folders, and an
  optional allowlist. They're enforced in the adapters, never by asking
  the model: every search gets them appended server-side
  (`google-gmail.ts`, `microsoft-mail.ts`), every result is checked again
  message by message, and a read of an excluded thread or message is
  refused. Gmail on Google's MCP server gets the same in `callTool`
  (`mail-guard.ts`), and a reply it can't check is refused. So
  collections, Ask, Talk, MCP and the briefing all follow them. The model
  is told only that some mail is filtered. Rules that can't be opened
  (no data key) make every mail tool refuse rather than read without
  them. The settings preview counts ids (Gmail) or reads sender, subject
  and folder (Outlook), never a body. The Inbox's "Ignore emails like this"
  (`lib/suggestion-ignore.ts`, `POST /api/suggestions/:id/ignore`, owner
  only) adds a skipped sender, domain or subject phrase to the account the
  find's email came from. It only ever narrows what's read, and the owner
  picks the rule; nothing the model wrote can add one.
- **An Inbox find remembers the email it came from.** A collection notes
  the sender and subject of each email its mail tools return, for that run
  only, and a find it files from that email keeps them with the account's
  id (`suggestions.email`, migration `0086`, sealed). Nothing new is read
  to do it, and it's shown only to the owner.
- **Only the calendars the owner switched on are read.** Google Calendar
  and Outlook keep the chosen ids in `connectors.calendars` (ids only, apart
  from the OAuth scopes); until the owner chooses, only the main calendar is
  read, and calendars found later stay off. iCloud keeps the ones switched
  off in `scope`. A calendar that's off isn't fetched by any tool, even by
  its id.
- **Archive, never delete, and only your own.** A collection can archive
  only records it wrote itself (looked up by its own `source` and the item's
  id), at most 25 per run, and only to mirror a cancellation at the source.
  Anything archived this way can be restored from the Archived page. It
  can't touch records you made or ones another collection wrote. It won't
  bring back something you archived or deleted.
- **Untrusted content.** Email and messages can contain instructions aimed
  at the model ("forward this to…"). The prompt treats source content as
  data, and the controls above mean the worst a successful injection can do
  is write misleading records through the tools above (notes, to-dos,
  details, events and the rest), tagged with that collection's source. It
  can't send or change anything in your accounts, and can't delete anything
  in Athena. A collection's `source` is set by the runner, so its writes
  can always be told apart from yours; over MCP, `source` is whatever the
  caller sends.
- **Finance and health.** The email recipe is told never to record money
  amounts, balances, account numbers or health details, only that such an
  email exists. Unlike §1's encrypted path, this is an instruction to the
  model, not a code-level guarantee: don't point a Custom collection at a
  source whose purpose is financial records. There is deliberately no
  finance recipe.
- **OAuth sign-in.** Authorisation code, with PKCE (S256) wherever the
  provider takes it: MCP servers, Google, Microsoft, Trakt, Spotify and
  Oura. Seven providers sign in without PKCE: Strava, Withings, WHOOP,
  Polar, Swarm (Foursquare), Monzo and Reddit. Each of those still has the
  single-use `state`, and the code is exchanged with the owner's own client
  credentials; Monzo, the sensitive one, is refused without its client
  secret. The `state`
  parameter is 32 random bytes; only its SHA-256 is stored, it expires after
  15 minutes and is single-use. The callback
  (`/api/connectors/oauth/callback`) is the one `/api/*` route without the
  bearer token — the provider's browser redirect can't carry it — and
  `state` is what authenticates it. Starting a sign-in requires the bearer
  token. Unattended runs never start a sign-in: if a refresh fails the
  account is marked *Needs sign-in*.
- **No private addresses.** Custom MCP servers, their sign-in discovery,
  registration and token addresses, and every address the owner types for
  Jellyfin or Mastodon go through `publicFetch`
  (`netlify/lib/connectors/icons.ts`): https only, and each connection's
  address is checked as its name is looked up, redirects included, so a
  name can't lead to a loopback, private, link-local or cloud metadata
  address. `netlify dev` still reaches a local MCP server. Two gaps:
  - **An address written as a bare IP** (`https://10.0.0.5/…`) involves no
    lookup, so `publicFetch` alone doesn't check it. Saved, link previews,
    art, maps, icons, Jellyfin, Mastodon and the Plex probe check the host
    first (`assertPublicHost`) and aren't affected. A custom MCP server's
    sign-in, registration and token addresses rely on `publicFetch` alone,
    so a server the owner connected could name an internal IP there.
    Certificates are still checked.
  - **Plex history reads use plain `fetch`**, to the server address
    plex.tv lists for the owner, with redirects refused.
- **OAuth settings entered by hand** (custom servers only). For servers that
  don't publish OAuth metadata, the owner can enter the provider's
  authorization and token URLs; Athena then sends the client secret, the
  authorization code and refresh tokens to that token URL, so it's held to
  the same rules as server URLs (https only, no credentials in the URL) and
  only settable with the bearer token. The URLs, grant, client-auth method
  and audience aren't secret and live in `connectors.oauth`; the client
  secret stays sealed. Changing them (or the client) deletes the stored
  tokens, registration and discovery results, so nothing issued for one
  server is ever sent to another.
- **Gmail and Google Calendar call Google directly.** These two don't go
  through Google's MCP servers (in Google's Workspace Developer Preview,
  which most accounts can't use): Athena calls `gmail.googleapis.com` and
  `www.googleapis.com/calendar/v3` itself (`netlify/lib/connectors/google-direct.ts`
  and the files beside it).
  - **Read-only by construction.** Every request goes through one function
    that sends GETs, the calendar writes and freeBusy read checked by
    shape above and under "Adding and moving events", plus a single POST to Gmail's `users/me/drafts` for
    `create_draft`, and refuses any other method or address. There is no
    code that sends, labels or trashes, and the one delete (`deleteCreated`)
    takes back only an event Athena added. `callTool`'s
    refusal of send, reply and forward tools still comes first, and
    `create_draft` is only offered, and only callable, for an account with
    drafts on.
  - **Fixed endpoints.** The API, sign-in and token addresses are written
    in the code; nothing is discovered from a server, so tokens and the
    client secret only ever go to Google.
  - **Sign-in** is the same authorisation code with PKCE (S256) and
    single-use `state` as above, at `accounts.google.com`, with the
    owner's own client and the same read-only scopes (`gmail.readonly`,
    `calendar.readonly`, plus `gmail.compose` only with drafts on). No
    `resource` parameter is sent.
  - **Tokens are sealed as before**, in `connectors.credentials`. They're
    renewed at `oauth2.googleapis.com/token` and the new access token is
    sealed again; only the access token, refresh token, expiry and granted
    scopes are kept. Tokens, message bodies and request addresses (which
    hold search words) are never logged.
  - **HTML is cut before it's read.** A message's HTML is cut to 500,000
    characters, and a calendar event's description to 60,000, before it is
    turned into text, in one forward pass (`htmlToText` in `google-api.ts`;
    feeds use the same function).
  - A refused sign-in marks the account *Needs sign-in* after one renewal,
    without retrying in a loop; a switched-off API or a permission left
    unticked at Google is shown in plain words on the account.
- **Fastmail email calls Fastmail's JMAP API directly, with an API token**
  (`netlify/lib/connectors/fastmail-direct.ts`, `fastmail-mail.ts`). There
  is no OAuth app: the owner makes a JMAP token in Fastmail (with
  "Read data") and pastes it; it's sealed like every other token.
  - **Read-only by construction, but for one switch.** One function sends
    every request and refuses any JMAP method outside `READ_METHODS`
    (`Mailbox/get`, `Email/query`, `Email/get`, `Thread/get`) before it's
    sent. With "Let Athena save drafts" on for the account, one write
    passes, checked by shape (`isDraftCreate`): an `Email/set` with only
    `create`, one new email, in one mailbox, with the `$draft` keyword. No
    `update` and no `destroy`, so nothing already in the mailbox can be
    moved, changed or deleted. Requests never name JMAP's submission
    capability, so nothing can be sent, whatever the token allows. Drafts
    need a token with "Make changes"; "Send email" is never asked for. A
    "Read data" token is enough for everything else.
  - **Fixed hosts.** The token goes only to `fastmail.com` and names under
    it, over HTTPS, in the Authorization header: the session address
    (`api.fastmail.com`) is in the code, the API address the session names
    is checked against the same rule, and a redirect is refused. The
    address stored on the account isn't used.
  - Attachments are named from the message's structure; their contents are
    never downloaded. Bodies are asked for as text, capped.
  - The owner's mail rules apply as for Gmail and Outlook: in the filter
    Fastmail runs, and checked again on every message that comes back.
  - Calendars and contacts aren't read, though a token covers them: Athena
    asks only for mail.
- **Outlook mail and calendar call Microsoft Graph directly**
  (`netlify/lib/connectors/microsoft-direct.ts` and the files beside it),
  for the same reasons and under the same rules as Google:
  - **Read-only by construction, but for three switches.** One request
    function sends GETs to `graph.microsoft.com/v1.0` and refuses any other
    address. Every POST and PATCH goes through `allowedWrite`, checked by
    shape: your answer to an invite (`isRsvpPost`, with "Let Athena answer
    invites" on), a new draft (`isDraftCreate`, with "Let Athena save
    drafts" on, see §10), a getSchedule free/busy read (`isSchedulePost`),
    a new start and end for an event you organise (`isMovePatch`) and a new
    event (`isCreatePost`), both with "Let Athena add and update events" on
    (see "Adding and moving events" below). `allowedWrite` refuses every
    DELETE; the one DELETE there is, `deleteCreated`, undoes an event Athena
    added and is sent only after `calendar_creates` says so. Nothing can
    send mail. Attachments are
    listed with `$select=name,isInline`, so their contents are never
    downloaded.
  - **Fixed endpoints**, in the code: Graph, and sign-in and token
    addresses at `login.microsoftonline.com/common`. Page tokens that carry
    a Graph `@odata.nextLink` are refused unless they point back at Graph.
  - **Sign-in** is authorisation code with PKCE (S256) and single-use
    `state`, with the owner's own Entra app and delegated read scopes only:
    `Mail.Read` or `Calendars.Read`, plus `User.Read` and `offline_access`.
    `Mail.ReadWrite` (drafts) and `Calendars.ReadWrite` (invites) are asked
    for only when you turn on their switch. `Mail.Send` is never asked for.
  - **Tokens are sealed** in `connectors.credentials`. Microsoft rotates
    the refresh token on renewal; the new one is sealed straight back, and
    never written over a newer sign-in. Tokens, bodies and request
    addresses are never logged.
  - An organisation that requires admin approval, an expired client
    secret, or an app limited to one organisation are each shown in plain
    words on the account.
- **iCloud Calendar and Contacts are called directly over CalDAV and
  CardDAV** (`netlify/lib/connectors/icloud-*.ts`):
  - **Read-only by construction, but for the calendar switches.** The
    request function takes GET, PROPFIND or REPORT and nothing else; no POST,
    PROPPATCH or MOVE exists in the code. The writes are three, each on one
    event's file: `putIfMatch` (your answer, or a move), `putIfNoneMatch` (a
    new event, checked by `isNewEventIcs`) and `deleteIfMatch` (Undo of an
    event Athena added, after `calendar_creates` says so). An app-specific
    password can change Calendar and Contacts, so this is what keeps iCloud
    read-only otherwise.
  - **Answering an invite is the one write, behind the switch.** With "Let
    Athena answer invites" on, `respond_to_event` (`icloud-rsvp.ts`) reads
    the event's file, changes only the PARTSTAT on your own ATTENDEE line
    (ACCEPTED, TENTATIVE or DECLINED; matched on your own addresses, never
    another attendee's or an alarm's), and puts it back with
    `putIfMatch`: a PUT to that one `.ics` file in your calendar home, with
    `If-Match` on the ETag it just read, so a change made meanwhile is a 412
    and never overwritten. A 412 re-reads and tries once more. Every other
    byte of the file is sent back as iCloud gave it. It never creates,
    moves, edits or deletes an event; an occurrence of a series with no copy
    of its own, your own event, or a cancelled one is refused. Without the
    switch the tool isn't offered, `callTool` refuses it, and the adapter has
    no way to PUT.
  - **The password only goes to iCloud.** Requests go to
    `caldav.icloud.com` / `contacts.icloud.com` and the account's own
    `pNN-caldav.icloud.com` / `pNN-contacts.icloud.com`, over HTTPS on port
    443, and nowhere else: the home address discovery returns is checked
    before it's used, redirects are followed by hand and only to those
    hosts, and an event or contact id can only name a file inside the
    owner's own calendar or address book home.
  - **Only the calendars the owner chose** are read, by any tool or
    collection; the rest aren't fetched at all.
  - **Sealed together.** The Apple ID and the app-specific password are
    sealed in `connectors.credentials` (`username` and `token`) and never
    sent to the app, which shows "Saved" instead. `key_from` copies them
    from one iCloud account to another on the server. A new password replaces
    the old one only on accounts that held exactly the same Apple ID and
    password, compared on the server; nothing is sent to the app. Nothing logs the
    password, the Apple ID, a request address or a reply.
  - **Revocable on its own.** The owner can revoke the password at
    appleid.apple.com without touching their Apple ID password, and
    changing the Apple ID password revokes it. A 401 marks the account
    "Make a new app-specific password" and isn't retried.
  - Replies are capped at 8 MB; contact photos are never kept.
- **Life log sources (Trakt, YouTube, Letterboxd, Goodreads) are called
  directly** (`netlify/lib/connectors/trakt-*.ts`, `youtube-direct.ts`,
  `feeds-*.ts`):
  - **GET only.** Each adapter's one request path sends GETs; the only
    other request is Trakt's token POST. Trakt has no read-only scope, so a
    Trakt token could change the account: Athena's code never does.
    YouTube asks for `youtube.readonly` only.
  - **Fixed hosts.** Trakt: `api.trakt.tv` (sign-in at `auth.trakt.tv`, PKCE, no client secret).
    YouTube: Google's API and token hosts. Letterboxd: `letterboxd.com`.
    Goodreads: `www.goodreads.com`. A profile or feed address is checked
    when the account is added and refused unless it's the service's own;
    redirects are followed by hand and only to those hosts; replies are
    capped at 2 MB. Goodreads' widget is JavaScript: Athena reads it as
    text and never runs it.
  - **Sealed.** Trakt and YouTube tokens are sealed in
    `connectors.credentials`, renewed tokens are never written over a newer
    sign-in, and nothing logs a token, a reply or an address with a
    username in it. Letterboxd and Goodreads store no secret: the profile
    address is kept in plain text like any server URL. Goodreads' "first
    seen" list (review ids and times, at most 100 per shelf) sits in the
    sealed credentials.
  - Only the owner's own activity is read. The Life log prompt forbids
    other people's usernames and message contents in notes.
- **ListenBrainz, Raindrop.io and Eventbrite are called directly**
  (`listenbrainz-direct.ts`, `raindrop-direct.ts`, `eventbrite-direct.ts`;
  docs/notes/connectors-audit.md):
  - **GET only, fixed hosts.** ListenBrainz: `api.listenbrainz.org`, with
    no key, since listens there are public; the account is the username,
    kept in plain text like a profile address. Raindrop.io:
    `api.raindrop.io`, with the owner's test token, which reaches only
    their own bookmarks. Eventbrite: `www.eventbriteapi.com`, with the
    private token of the owner's own API key. Both tokens are sealed in
    `connectors.credentials`. Eventbrite's private token can do anything
    the account can, which the setup steps say; Athena's code only reads.
  - **What's read.** ListenBrainz: each listen's track, artist, album,
    time, length and MusicBrainz id. Raindrop.io: each bookmark's title,
    link, site, kind, collection name, tags, favourite flag, a 300-character
    excerpt and when it was saved; never the saved page's text or
    highlights. Eventbrite: each order's id and status, and its event's
    name, start, end, link, venue name and town. The order's price, the
    buyer's name and email, the venue's street address and other
    attendees are dropped in the adapter and never reach Claude.
  - **What's kept.** What any Day entry keeps, sealed (§11): the title,
    subtitle, link, time and the source's id. Loading history on connect
    (below) writes the same entries: a listened entry per album per day,
    a saved entry per bookmark, an other entry per event that has happened.
- **Client credentials.** A custom server can use the `client_credentials`
  grant instead of a browser sign-in: Athena exchanges the sealed client ID
  and secret for a short-lived access token whenever it needs one. That token
  acts as the app, not as you, so scope it read-only at the provider. No
  refresh token is stored for this grant.
- **Server URLs** (and OAuth authorization/token URLs) must be `https://`
  (plain `http://localhost` only under `netlify dev`) and may not carry
  credentials in the URL.
- **The background runner** (`/api/collect-run`) requires the same bearer
  token as the API, and only accepts run ids that are queued; a run is
  claimed atomically so a retried invocation can't execute it twice.
- **Custom servers' logos.** A server's `initialize` reply can list icons;
  failing that, Athena looks for its website's icon. Those addresses come from
  the remote server, so they're fetched server-side with SSRF guards
  (`netlify/lib/connectors/icons.ts`):
  - https only;
  - every host, including every redirect hop, is resolved, and refused if it
    lands on a loopback, private, link-local or other internal address
    (IPv6 forms that carry an IPv4 address are judged by that address);
    the check runs again on the connection itself (`publicFetch`), so a
    name that answers differently the second time (DNS rebinding) is refused;
  - a 5-second timeout per request and 8 seconds overall;
  - a 96 KB cap per image.

  The bytes have to actually be an image (PNG, JPEG, GIF, WebP, ICO or SVG);
  the declared content type isn't enough. The result is stored as a `data:`
  URI and only ever shown in an `<img>`, where an SVG's scripts don't run.
  The app never contacts the server or its website for a logo. Built-in
  services skip this entirely: their marks are drawn in the app.
- **Removing an account** deletes its stored credentials. It doesn't revoke
  the grant at the provider; do that in the account's own security settings
  (e.g. Google Account → Security → Third-party access) as well.

### Adding and moving events (`lib/scheduling.ts`, `lib/availability.ts`, `lib/calendar-creates.ts`)

"Let Athena add and update events" is a per-account switch for Google
Calendar, Outlook and iCloud Calendar, separate from answering invites. It
was "Let Athena move events you organise" and keeps that switch's marker,
so an account that had moving on has adding on too, with no migration.

- **The switch.** Athena's marker `athena:move-events` (`MOVE_MARKER`) in the
  account's `scope`. It's never sent to a provider: `oauthScope` strips every
  `athena:` marker at sign-in and renewal, and, with the switch on, adds the
  calendar write permission (`calendar.events` or `Calendars.ReadWrite`).
  Turning it on doesn't turn on answering, and the reverse. Without it
  `move_event`, `create_event` and `undo_create_event` aren't offered,
  `callTool` refuses them, the adapters have no way to send them, and
  they're refused on an MCP server.
- **Moving: only the start and end, only your own events.** `move_event` first reads
  the event and refuses unless you organise it (Google `organizer.self`,
  Graph `isOrganizer`, iCloud `ORGANIZER` is one of your addresses or there's
  none), and refuses all-day events, whole repeating series and cancelled
  events. `expect` (the start Athena last saw) refuses a move if the event
  moved meanwhile.
- **Moves, checked in code, by shape.** Google: `isMovePatch`, a PATCH to one event
  with `?sendUpdates=all` and a body of exactly `start` and `end`, each a
  `dateTime` with its offset and maybe the event's own `timeZone`, the end
  after the start. Graph: `isMovePatch`, a PATCH to `/me/events/{id}` with
  exactly `start` and `end`, each `{ dateTime, timeZone: "UTC" }`. iCloud
  (`icloud-move.ts`): the event's file with only `DTSTART` and `DTEND`
  changed (each keeps its TZID or UTC) and `SEQUENCE` raised by one when
  there are guests, as RFC 5546 asks, checked by `onlyTimesChanged` before a
  `putIfMatch` (If-Match on the ETag just read; a 412 re-reads once). A
  `DURATION` event keeps its length. Anything else is refused before it
  leaves the server.
- **Adding: one event, these fields only.** `create_event` reads only a
  title, start, end, time zone, place, description and guests
  (`readCreateArgs`; any other argument is refused, and the account's own
  address is never invited). Each provider's request is checked again by
  shape before it's sent. Google: `isCreateInsert`, a POST to
  `calendars/{id}/events?sendUpdates=all` (so guests get Google's invite)
  with only `summary`, `start`, `end`, `location`, `description` and
  `attendees` as `{ email, displayName? }`, up to 50; no conferencing,
  reminders, colour, visibility, recurrence or attachments. Graph:
  `isCreatePost`, a POST to `/me/events` (or `/me/calendars/{id}/events` for
  another calendar the owner picked, only after Athena reads it and finds
  the owner owns it and can edit it, so never a calendar shared with them)
  with only `subject`, UTC `start` and `end`, `location.displayName`, a
  plain-text `body` and `attendees` by address, plus `showAs: "busy"` on a
  block with no guests; no online meeting, reminder, category or
  recurrence. iCloud
  (`icloud-create.ts`): a new `.ics` file whose one VEVENT has only `UID`,
  `DTSTAMP`, UTC `DTSTART` and `DTEND`, `SUMMARY`, `LOCATION`,
  `DESCRIPTION` and, with guests, `ORGANIZER` (you) and `ATTENDEE` lines
  (`isNewEventIcs`), sent as a PUT with `If-None-Match: *`, so it can only
  make a new file, never replace one. iCloud sends the invites.
- **Which calendar.** Only calendars the owner switched on (§9) and can write
  to (`accessRole` owner or writer), each account's main one by default;
  the owner can pick another in the confirm sheet. A read-only or switched-off
  calendar is refused by the adapter.
- **Bookings and focus blocks invite no one.** Check in's "Add to calendar"
  (`kind: "booking"`) and a to-do's "Block time for this" (`kind: "focus"`)
  are refused by `createEvent` if any guest is sent. A focus block's time
  comes from `findSlots` (the owner's working hours, no guests).
- **Focus time, Google only, off by default.** With "Block time as Focus
  time" on (Settings → Days, `days_focus_time`), a to-do's block on Google's
  main calendar also carries `eventType: "focusTime"` and
  `focusTimeProperties` of exactly `autoDeclineMode:
  "declineOnlyNewConflictingInvitations"` and `chatStatus:
  "doNotDisturb"`. `isCreateInsert` allows those two fields only together,
  only with those values and only with no guests. Google then declines new
  invites booked over the block, which the setting says. Outlook blocks are
  `showAs: "busy"`; iCloud blocks are plain events, busy by default.
- **Undo deletes only what Athena added.** Each event Athena adds is a row
  in `calendar_creates` (migration 0048: account, calendar and event ids, the
  link, when, and when it was undone; no title, time or guests). Undo
  (`op: "create_event"`, through `/api/assistant/undo` or
  `/api/scheduling/undo`) names that row, and is refused once it's been
  undone. The delete itself is refused unless the row is there: Google's
  `GoogleSession.request` and Graph's `allowedWrite` refuse every DELETE,
  and the only methods that send one (`deleteCreated`) check
  `calendar_creates` first (`isCreatedDelete`: one event, Google with
  `sendUpdates=all`, so guests get a cancellation; Outlook sends one too).
  iCloud's `deleteIfMatch` is sent only by `undo_create_event` after the same
  check, over the ETag just read; iCloud sends the cancellation. A delete
  of any other event isn't possible from Athena.
- **The owner confirms every move and every new event.** Ask's
  `move_event` and `create_event` and the slot card only propose; a move
  happens at `POST /api/scheduling/move` after a tap on Move in the confirm
  sheet ("Move 'Design review' to Thu 14:00? Guests get an update."), and an
  event is added at `POST /api/scheduling/create` after a tap on Add in its
  sheet, which shows the title, when, where, which calendar and who gets an
  invite ("Priya and Marcus get an invite"). Ask's `create_event` asks the
  owner first when a name fits more than one person or someone has no
  email, and shows nothing until then. Shortcuts can't call any of these
  tools. Move's Undo (`op: "move_event"`) moves it back with the same
  checks, and is refused if the event has moved again since.
- **Guests' calendars: busy or free, nothing else.** `free_busy` is a read
  and needs no new permission: Google's `freeBusy` POST (`isFreeBusyPost`:
  exactly `timeMin`, `timeMax` and up to 20 `{ id }` addresses) and Graph's
  `getSchedule` POST (`isSchedulePost`: exactly the addresses, a UTC range
  and an interval). Neither is retried as a write. `parseFreeBusy` and
  `parseSchedule` keep only start, end and status (and Outlook's working
  hours); Graph's subjects and locations for colleagues are dropped there
  and never reach Ask, the app or a log. A calendar a provider won't show is
  named ("Couldn't see Sam's calendar") and left out of the search. iCloud
  has no way to see other people's calendars, so it has no `free_busy`.
- **The owner's own busy times** come from `list_events` on the calendars
  they switched on (§9), travel from `lib/trips.ts`, and working hours from
  `settings.days_working_hours` (`GET/PUT /api/scheduling/hours`, behind the
  bearer token like every route here).

### YouTube watch history from Takeout

A Takeout file never leaves the device: the app reads it there and sends
only, per day, each video's id, title, channel and play count, behind the
bearer token. Ads, removed videos and everything else in the export
(search history, comments, the rest of a zip) are never read or sent. The
server checks every value (real dates, 11-character video ids, lengths
capped, at most 62 days and 4,000 videos a request), refuses anything not
for a YouTube account, and writes only Life log day notes, sealed like
every note (§11), plus their `collected_items` row and, if asked, a
`videos_watched_day` count. It never changes a day you archived or
deleted, and a day whose note won't decrypt is skipped rather than
overwritten. The Life log run can't remove the imported sections: the
runner puts them back on every save.

### History loaded on connect (`netlify/lib/connectors/backfill.ts`, migration `0054`)

When an account with history is connected (Trakt, YouTube, Last.fm,
Spotify, Plex, Jellyfin, Letterboxd, ListenBrainz, Raindrop.io,
Eventbrite), Athena reads that history from the
service itself, with the account's own sign-in, and writes it into Days
and Watch & read. No model is involved.

- **Reads only.** The same read-only sessions as a run: Trakt GETs to
  `api.trakt.tv/users/{slug}/history/`, `/users/{slug}/ratings/` and `/users/{slug}/watchlist/movie,show/added`, with the account's own slug from `/users/settings` (the bare `/sync/…` reads came back empty, 10 Nov 2026);
  YouTube GETs to the Data API's `channels`, `playlistItems`, `playlists`
  and `subscriptions` (`youtube.readonly`; Watch & read also reads `videos`
  for lengths and topics, §13); the others call their own read
  tools (`list_scrobbles`, `saved_tracks`, `saved_albums`,
  `watch_history`, `list_diary`, `list_listens`, `list_bookmarks`,
  `list_orders`). Nothing is posted, rated, liked or
  scrobbled.
- **What's kept.** Per item: its title, who made it or which episode, the
  service's id, its link, when it happened and the rating the owner gave.
  Titles, subtitles, links and ids are sealed like every Day entry and
  Watch & read item (§11). YouTube's liked and playlist videos go into Watch & read as videos too. Trakt's collection, YouTube comments and other
  people's activity are never read.
- **Progress.** `settings.history_load.<account id>` holds counts, the oldest
  day, the state, a short owner-facing reason when it stops, and the next
  page's cursor (a Trakt page number, a YouTube page token, or a playlist
  id). The cursor never leaves the server: `GET
  /api/connectors/:id/backfill` drops it.
- **Who can start it.** Connecting the account, or `POST
  /api/connectors/:id/backfill`, behind the bearer token. The work runs in
  the background function at `/api/backfill-run`, which takes the same
  bearer token and only account ids. The scheduled tick picks up loads
  that stopped.
- **Only what's allowed.** Each part of a load stands for the account's read tools (Trakt's history is `list_history`) and runs only when the owner allows them under "What Athena can read". With none allowed, nothing is read until they choose.
- **Home Connect appliances (owner decision, 11 Nov 2026).** Bosch, Siemens, Neff and Gaggenau appliances, through Home Connect's official API (`netlify/lib/connectors/homeconnect-direct.ts`, `lib/presets/home.ts`).
  - **Read-only by the sign-in itself.** The owner registers their own Home Connect app and signs in; Athena asks for `IdentifyAppliance Monitor` only, never `Control` or `Settings`, so the token can't start, stop or change an appliance. The adapter makes GETs only, to `api.home-connect.com`: the appliance list, each connected appliance's status, and the active programme of one that's running.
  - **Athena's own look, every 15 minutes** (`netlify/lib/home/appliance-sync.ts`, from the collections scheduler and each Home run; no model), for the accounts an enabled Home collection reads. It sets what it sees against what it saw last and writes a Days entry for each programme that finished in between (kind `other`, source `home_connect`: the appliance's name, the programme, how long). A 429 leaves the account alone for an hour and is never retried. A refused sign-in marks the account "needs signing in".
  - **Sealed.** What an appliance is doing, and when it last ran, shows when someone's home. The picture Athena keeps is one sealed settings row (`settings.appliances`); the Days entries are sealed like every other entry. Appliance ids, names and states are never logged. Without the data key nothing is read.
  - **Where it shows.** Days, the House page (from the sealed row: nothing is asked of Home Connect when the page opens), and Ask, through its own `appliances` read tool, which reads the same sealed row and never calls Home Connect. The account's live tool is not offered to Ask.
  - **Not verified against the service.** Home Connect's documentation couldn't be reached when this was written; the calls follow the aiohomeconnect library. The first sign-in is the first real request.
- **Spotify playlists, the exception (owner decision, 10 Nov 2026).** Athena's own playlist read for Music (`netlify/lib/connectors/playlist-sync.ts`, in each Life log run and as the last step of Load history again) runs whatever "What Athena can read" says, like the money and places syncs. It reads only the playlist list and the tracks of the owner's own and collaborative playlists, and keeps them sealed in one settings row (`settings.music_playlists`). Ask and a Life log run's model see `list_playlists` and `list_playlist_tracks` only when the owner ticks them. A sign-in from before the playlist scopes just reads "Sign in again"; nothing else is sent anywhere, and no cover image is fetched from Spotify.
- **Limits.** At most 20,000 items a stream (Last.fm's scrobbles and ListenBrainz's listens: 100,000). A 429 waits an hour and a
  5xx waits 15 minutes; after six stops in a row it gives up.
- **Marked.** Rows it made are `backfilled = true` and dated when they
  happened. They are never counted as new, and nothing sends a push.
  Logs carry counts and states only, never a title or an id.

### Your activity (`netlify/lib/connectors/media-sync.ts`, `activity-recent.ts`, migration `0064`)

A collection with no model, called Plays and watches until 12 Nov (its
recipe id is still `plays-watches`). Each run (every hour by default, on
the collections scheduler, `collect.ts`, or Run now) reads what's new on the
accounts it's given: Spotify, Last.fm, ListenBrainz, Trakt, Plex, Jellyfin,
YouTube and Letterboxd, and since 12 Nov Goodreads, Readwise, Steam,
Lichess, Chess.com, Raindrop.io, Eventbrite, Habitify, Todoist (with an API
token), Reddit, Bluesky, Mastodon, Strava, Oura, Withings, Whoop and Polar.
Claude is never called, so it also runs when AI Gateway isn't set up.

- **Same reads, more often.** It calls each account's own read tools, the
  same endpoints and scopes a Life log run uses: Spotify's
  `recently_played`, Last.fm's `list_scrobbles`, ListenBrainz's
  `list_listens`, Plex and Jellyfin's `watch_history`, Letterboxd's
  `list_diary`, Trakt's history, watchlist, playback and ratings GETs,
  YouTube's likes, playlists, playlist items and subscriptions (the last
  three every 6 hours), Spotify's saved tracks and albums,
  Goodreads' `list_books` (the public shelf widgets), Readwise's
  `list_highlights` with `text: false`, Steam's `played_games`, the chess
  sites' `list_games`, Raindrop.io's `list_bookmarks`, Eventbrite's past
  `list_orders`, Habitify's `habits_on`, Todoist's `routines_on`, Reddit's
  `my_posts`, `my_comments`, `my_saved` and `my_upvoted`, Bluesky and
  Mastodon's `my_posts`, each health account's `day_summary`, and Polar's
  `changed_days`. The evening Life log run also GETs Trakt's ratings
  (`/users/{slug}/ratings/`, as the history load) to put ratings on watched
  entries; Last.fm and ListenBrainz are read a week back then. No new scope,
  host or write. Each read asks from the last-seen point (`after`, or one
  local day at a time with `date`), or pages from the newest until it
  passes it. Health days re-read the last 3 days every time.
- **The owner's choice.** It's a collection: offered when one of these
  accounts connects, and only the accounts it's given (an existing one
  gains an account only when the owner adds it), only while it's enabled,
  and only the reads allowed under "What Athena can read". Polar's
  `changed_days` is asked only when it's allowed (asking clears Polar's
  list).
- **Other people stay out.** The same rules as the Life log, in code: chess
  entries carry the day's count and the site's summary line, never an
  opponent; Readwise is asked for counts only, so no highlight or note text
  is read; a Reddit comment is the post's title and the community, never
  anyone's text; nsfw and private-community items are "Posted in r/…" or
  "Saved a post in r/…" with nothing else; Bluesky and Mastodon titles are
  the owner's own first words with @handles and links taken out, a reply is
  "Replied: …" with no name, and a post with a content warning shows only
  the warning. Eventbrite entries have no price or other attendees.
- **Health stays sealed.** Health accounts write only sealed health days
  (`saveHealthDay`), never an entry, title, metric or summary figure. The
  run counts workouts and days, nothing more.
- **What's kept.** Day entries and Watch & read items as the history load
  writes them, sealed the same way, linked to the run like any run's.
  `settings.media_sync.<account id>` holds each stream's last-seen time, a
  lease, a wait, for music each open day's play times under a 16-character
  hash of the entry's id, and what it has counted as `[count, day]` under a
  hash. Steam keeps each game's total hours under a hash of its app id,
  Reddit the hashes of saved and upvoted items it has seen. No titles,
  names or ids. The run's summary is counts only ("6 plays, 1 watch, 2
  books, 1 workout"), a wait's reason, and Steam's note when a profile is
  private.
- **Daily counts.** `books_finished_day`, `highlights_made_day`,
  `game_minutes_day`, `chess_games_day`, `posts_made_day` and the film,
  episode, video and track counts are worked out from the day's entries
  (`activity-metrics.ts`) and written under the Life log's name, never by
  Claude. No health metric.
- **Limits.** A 429 waits an hour, a 5xx 15 minutes. At most 10 pages a
  stream a run, 8 days a stream, 2 minutes an account. Logs carry counts
  only.
- **The evening run.** A Life log run checks the accounts an enabled Your
  activity collection reads once more without a model, then doesn't offer
  their listings to Claude, and for a source read whole (every one with a
  direct adapter, media included) gives it no tool for it at all:
  no `athena_health_day` for a covered health account, any entry it sends
  for that source is dropped, and `athena_metric` refuses the counts Athena
  makes itself. It sees what's already in Days (titles, as it would have
  read them itself; never health) for each day's line, from every account
  an enabled Your activity collection reads, and drops entries for a source
  read whole whichever Life log sends them.

### Your work, counted (`netlify/lib/connectors/work-sync.ts`, migration `0066`)

A collection with no model, like Plays and watches. Each run (every hour
by default, on the collections scheduler, or Run now) reads the owner's own
work from the Linear and GitHub accounts it's given. **Claude is never used
for it**: the tools are called with fixed arguments through `callTool`, and
the replies are parsed in code (`work-parse.ts`). It runs without AI Gateway.

- **What is read.** Linear: `get_user` with "me" (the owner's id) and
  `list_issues` with assignee "me" and an `updatedAt` point. GitHub: `get_me`
  (the login), `search_pull_requests` for PRs the owner opened, other
  people's PRs the owner reviewed, and merged PRs involving the owner;
  `pull_request_read` `get_reviews` for each new or changed PR, and `get` for
  each merged one, kept only when its `merged_by` is the owner (search has
  no "merged by" filter). A PR someone else merged is remembered in the
  state as a hash and a time, so it isn't asked about again until it changes.
  Linear's tools don't say who closed an issue, so an issue the owner closed
  but didn't own isn't counted: finding one would mean reading the team's
  issues. The same account, scopes and allowlist as any
  collection: only while the collection is enabled, and only when the owner
  allows those reads under "What Athena can read". `pull_request_read` is optional;
  without it there are no review counts and no merges for others.
- **What is stored.** In `work_items`, one sealed value per item, keyed by
  the source and a hash of its id (no id or repo name readable in the
  table). A Linear issue: id, identifier, title, link, project, team, state,
  created, started and completed times, estimate. A PR: repo, number, title,
  link, opened, merged and closed times, how many reviews other people left
  (a count), when the owner first reviewed it, or that the owner merged it. Never a description, a
  body, an assignee, an author or a reviewer's name. An issue assigned to
  someone else is dropped by the parser, and `saveWorkItems` refuses a PR
  that carries an author; tests check both.
- **State.** `settings.work_sync.<account id>`: the newest change seen, a
  page or cursor to carry on from, a lease and a wait. No titles.
- **Limits.** 10 pages a stream a run, 60 review reads, 2 minutes an
  account. A 429 waits an hour, a 5xx 15 minutes. A reply in a shape Athena
  doesn't know fails that account with a plain error and stores nothing.
  Logs carry counts only; the run summary is counts ("3 issues, 2 pull
  requests") and a wait's reason.
- **Other people's work.** Ask may read a teammate's issues or PRs live
  from the same accounts ("what's on Priya's plate?"), as it reads any
  account. Nothing about them is kept: Ask's import never saves from Linear
  or GitHub (`LIVE_ONLY_PROVIDERS`, checked again by the account's stored
  provider in `ask-import.ts`), and the work sync stores the owner's own
  activity only. The answer itself stays in the owner's Ask chat like any
  other answer, and the owner can delete it (owner's choice, 12 Nov). The
  switch `LIVE_ANSWERS_NOT_KEPT` in `lib/answer-text.ts` (off) would instead
  keep only the question, with `lib/ask-threads.ts` scrubbing the rest on
  the server.
- **Work activity.** Still uses Claude, for notes only (what shipped, what
  was decided, what's stuck). It no longer writes metrics and isn't offered
  `athena_metric`.

### Documents Athena writes: Google Docs, Notion and templates

The owner can send a note out (`lib/documents.ts`): "Send to Google Docs"
makes a new doc, "Send to Notion" a new page. These are the only writes to
either service, and each one makes something new rather than changing what
the owner already has.

- **Google Docs asks for `drive.file` only.** That permission lets Google
  show Athena only the files Athena made. It can't see, list, read or
  change anything else in the owner's Drive. The account is direct
  (`netlify/lib/connectors/google-docs.ts`), and the API, sign-in and token
  addresses are fixed in code. It signs in with the owner's own Google
  client, using PKCE and single-use `state`, and the tokens are sealed in
  `connectors.credentials` like every other account's. It has no tools, so
  collections, Ask's answers and Claude never reach it.
- **Every Google request passes one gate** (`googleDocsRequestProblem` in
  `lib/documents-rules.ts`), which allows only these:
  - look up the folder named Athena;
  - make that folder, or a Google Doc inside it;
  - read a doc's length, then fill or rewrite it with text and formatting
    changes;
  - rename or trash a doc.

  Each of these needs a file id from `document_exports`, the list of what
  Athena made (migration 0047). Any other method, address, query
  parameter, body field or id is refused before the request leaves Athena.
  Writes are never retried after a dropped connection, so nothing is made
  twice. Tokens, document text and request addresses are never logged.
- **Notion is opt-in per account.** "Let Athena create pages" stays off
  until the owner picks a parent page. Turning it off clears the choice.
  Notion goes through its own MCP server with the account's existing
  sign-in. Notion has no permission that covers only creating pages, so
  Notion's consent screen says Athena could edit what it can see.
  Athena's code is what keeps it narrow. `callNotionWrite` (a block of its
  own in `mcp-client.ts`, apart from `callTool`) allows exactly three tool
  names, compared exactly:
  - `notion-create-pages`: one page, straight under the chosen parent,
    holding only a title and Markdown;
  - `notion-update-page`: only on a page in `document_exports`, and only to
    add text, rewrite the text or change the title;
  - `notion-move-pages`, for Undo only: one page in `document_exports`,
    moved under Athena's own "Removed by Athena" page and nowhere else.

  Duplicating, deleting, databases and every other tool are refused, and
  so is any update or move of a page Athena didn't make. The three write
  tools are still classed as writes, so collections and Ask's sources never
  see them.
- **Undo** is offered on every send, as a receipt with "Open in Docs" or
  "Open in Notion". In Google Docs, Undo moves the doc to Drive's trash,
  where the owner can still restore it for 30 days. Notion's server has no
  way to archive a page, so Undo moves the page Athena made under a
  "Removed by Athena" page. That page sits under the chosen parent, is made
  by Athena the first time it's needed and is kept on Athena's list. The
  page stays recoverable, and the owner deletes it in Notion when they're
  sure. Nothing is cleared or overwritten. Sending the note
  again updates the same doc or page instead of making another. The links
  shown are checked: only `docs.google.com/document/d/<that id>` or
  `notion.so/…<that id>`.
- **What leaves Athena:** the note's title and body as the owner sees them,
  with `athena://` links turned into their plain labels. Nothing else goes.
  The document titles kept in `document_exports` are sealed (§11).
- **Templates are filled by Athena, not by Claude.** `lib/template-fill.ts`
  copies each field from one named record: the calendar event, the people
  at it (details, the latest catch-up, open to-dos), an Email digest note
  already in Athena, a trip and its bookings, each day's line, to-dos and
  projects. Each part is cited under Sources, and a field with nothing
  behind it stays a visible `{{blank}}`. Nothing is invented, and no
  mailbox is read when filling. Health, money, mood and journal never go
  in: a week's days give only each day's line or where it went. Template
  names and bodies are sealed (§11). A template someone else shared fills
  the same way, from the owner's own records only (Community, below).
- **Ask's `fill_template` and `send_note`.** Claude chooses the template and
  what it's about (an event, people, a trip, a project). It gets back only
  which fields were filled and which were left blank, never the text, so
  collected text can't reach the model through this tool and the model
  can't add to it. Everything the note collects (an email's lines, a
  catch-up) is data and is never followed as an instruction. For a template
  someone else shared, the result holds only Athena's words: the fields
  Athena knows, by their own names, and a count of the rest; never that
  template's heading or its own field names. `send_note`
  sends nothing itself: it prepares a card, and the doc or page is made at
  `POST /api/documents` when the owner taps Send or Update (§10, "Outward
  actions wait for a tap"). A Shortcut has no such tool (§5).

## 10. Ask's assistant

Ask is one assistant (owner, 12 Nov 2026). Every message goes to one model
loop, `runAsk` in `lib/answer.ts`, through `POST /api/assistant`: Claude (via
Netlify AI Gateway) holds the read tools, the connected accounts, web search
and a fixed set of Athena tools that change things (`lib/assistant.ts`,
`lib/assistant-records.ts`, `-fields.ts`, `-kinds.ts`). Nothing in front of
the loop decides whether a message is a question or an instruction. The
write tools go through the same lib functions as the app and MCP, so the
same checks apply.

### One loop: who can ask for a change

Until 12 Nov 2026 a question went to a back end with no write tools, so text
that got past the prompt could cause a wrong answer and nothing else. That
is no longer true: the model call that reads an email can also call a tool
that changes Athena. Every guard from before still holds (below), and three
rules were added. The prompt states them; `lib/ask-guard.ts` enforces them
in code, where the model's words can't change the outcome.

- **Only the owner's own words ask for a change.** Whether a change was
  asked for is read from the owner's message alone (`askedFor`): an
  instruction at the start of the message or of a clause ("…, and add a
  to-do to follow up"), by kind (add, change, remove, link, send). Nothing a
  tool returned, and nothing an earlier reply said, is ever read for it.
- **After reading other people's words, a change waits for approval unless the
  owner plainly asked for it.** A turn has read other people's words once
  it has a result from a connected account, a web search result, a file
  (this message's, an earlier one's summary, or `read_file`), or text from
  a collected note (owner, 12 Nov 2026). A note is collected when its
  `source` is anything but `manual` or `app` (`isCollected`): notes from
  email and meetings, the Life log, and also a note with no source, one
  Ask wrote (`assistant`) and one sent from a shortcut or the browser
  extension. It counts when the first search or `search_athena` returns
  its snippet, when `read_note` opens it, and when `find_notes` returns
  its excerpt. The first search runs on every message except a Team run's
  and a request (`isRequest` in `lib/answer.ts`: one that opens with a verb
  such as remind, add or set), so most questions that touch a collected
  note are held to this rule; a request that opens one itself, with
  `search_athena` or `read_note`, is held the same way. From then on a
  write tool whose kind the owner's message didn't ask for is not run. It's
  kept as a plan card with one step (`plan.why: "read"`), and nothing
  happens until the owner taps Approve. The check is made when the change is
  queued: one queued before anything was read can't have been caused by it.
  A change of the kind the owner did ask for runs as before (one is made,
  two or more are a plan). Every write tool is in a fixed list
  (`TOOL_ASKS`); one that isn't listed always waits for approval, and a test
  checks the list covers the Session's tools.
- **A flagged result removes the write tools and web search for the rest of
  the turn.** When Jev's `guardText` flags anything read (a note, a search
  snippet, an account's result, a mention, a skill's file), the next model
  call is sent without any write tool or `web_search`, a call to one is
  refused in code, the model is told why, and anything already queued
  waits for approval (`plan.why: "flagged"`). Reading and answering carry on, and
  the reply says something was treated as plain text.
- **In a Team assistant's unattended run, its allowlist is the owner's
  standing request** (owner, 13 Nov 2026). A run is started by a trigger and
  has no message from the owner, so its words ask for nothing. The
  allowlist is what the owner ticked that assistant may do alone.
  - A change on the allowlist runs alone, as it did before the one loop,
    even when the run was started by, or has read, other people's words.
  - A change that isn't on the allowlist waits for approval as a plan.
  - If anything read in the run is flagged as an instruction, no write tool
    runs, allowlisted or not, and what was queued waits for approval.
  - A chat with an assistant is unchanged: the owner's own message decides.
    There the allowlist only lets an allowed change run without approval where
    the guard would let it run anyway.

  The guard is given the allowlist when the turn starts (`TurnGuard`'s
  `standing`, set in `lib/answer.ts` for a run only). Nothing reads it from
  a tool result, so nothing read can add to it. A run opens no connected
  account. It looks things up online only when the owner turned on that
  assistant's web switch, and then opens only links the owner supplied or
  approved ("Links a turn may open", below).
- **A tracker link a model chose always waits for approval**, allowlisted or not
  (`needsOwnersGo` in `lib/ask-guard.ts`): `track` with a `url` is never
  run alone, in a run, a chat or main Ask, even when the owner's message
  asked to track something. It's kept as a plan step (`plan.why: "link"`).
- **What an injection can still do.** Past all three: a wrong answer; a
  cited link the owner didn't expect; that item saved to Athena (below); a
  plan or confirm card the owner would have to tap; words Claude read going
  into a web search before any flag (below); and, when the owner's message
  itself asked for a change of the same kind, a wrong change of that kind,
  which shows as a receipt with Undo. In a Team run it's the same for a
  change on that assistant's allowlist: unflagged text can cause a wrong
  one, with its receipt and Undo. It can't make a change of a kind the
  owner didn't ask for or allow, send anything, or delete anything.
- **Tested** (`lib/ask-one-loop.db.test.ts`, `lib/ask-guard.test.ts`): an
  email that asks for a to-do and an archive, with a scripted model that
  obeys it. Unflagged, nothing is written and the change comes back as a
  plan; with the owner asking for a to-do in the same message, an archive
  still waits; flagged, the write tools and web search are absent from the
  next call and the call the model makes anyway is refused.
  For a run (`lib/ask-guard.test.ts`, `lib/team-mind.db.test.ts`): an
  allowlisted change runs alone after a collected note was read; one that
  isn't allowlisted waits; a flagged read stops both.

- **What it can do:** create, find, change, archive and restore almost
  anything: people (every field, including where they work), places,
  organisations, events, goals, life admin, projects, notes, checklists,
  to-dos, reminders, watch & read, links between records, and the owner's
  own types, records and fields. Trips, bookings and purchases too
  (`save_trip`, `save_booking`, `save_purchase`): from what the owner types,
  or from a booking PDF or order screenshot they share; each input is
  checked with zod before it runs, and never a price. One change can cover many people at once ("everyone with an
  @brightwater.co email works at Brightwater"), up to 500.
- **Custom fields:** it adds one of the owner's own fields (asking first
  unless the owner asked for it by name) and sets or clears values. It
  renames, re-options, re-units, reorders, archives and restores a field
  when asked; a type change is only allowed when it's safe for the values
  already there (`typeChangeAllowed`).
- **What it can't do:** delete anything, or change connectors or settings.
  There are no tools for these. Nothing it does leaves Athena without the
  owner's tap (next point). It reads health, places, mood and money
  only through the shared read tools below, and changes none of them.
  Asked to delete something, it archives it and says the owner can delete it
  for good from the Archived page. Reminders aren't archivable, so
  "cancelling" one marks it done, as MCP does.
- **Outward actions wait for a tap** (`lib/assistant-confirm.ts`). Three
  tools reach a connected account, and each only prepares a card under the
  reply; the model is told to say "ready to confirm", never "done":
  - `answer_invite`: the card names the event, the answer and where it
    goes. The RSVP is saved and sent at `POST /api/events/:id/rsvp` when
    the owner taps Going, Maybe or Decline.
  - `draft_message` / `draft_email`: Ask writes the draft and never saves
    it. For an email on an account with drafts on, "Read…" opens the draft
    sheet, and it reaches Gmail or Outlook Drafts only from Save there.
  - `send_note`: the doc or page is made at `POST /api/documents` when the
    owner taps Send or Update (§9, "Documents Athena writes").

  A plan doesn't queue these; they wait for their own tap. Moving and
  adding calendar events wait for the confirm sheet in the same way (§9,
  "Adding and moving events"). No `lib/assistant*.ts` file calls
  `saveDraft`, `sendNote` or `answerEvent`; a test checks it.
- **People:** it never adds a person on a guess. It asks first, with buttons.
- **Files:** when the conversation has files, Claude sees them (photos and
  PDFs as they are, text as text) and gets one more tool, `attach_file`,
  which puts one of *those* files on a note. Undo takes it off again; the
  file stays with the conversation. Only the newest message's own files go
  in whole; earlier ones go as their saved summary, and `read_file` reads
  one of *those* files again in full (it can't reach any other file).
- **Pictures** (`lib/images.ts`, owner, 17 Nov 2026): in Ask's and an
  assistant's chats only, with a picture model chosen (pictures are off by
  default), `make_image` sends the prompt the model wrote, and for a change
  the pictures named from *this* conversation (nothing else can be named), to
  that provider through AI Gateway, with the gateway's own key (or the
  owner's own key, straight to the provider, below), as JSON. Only
  the status is logged, never the prompt or the reply. What comes back is
  checked as an image by `sharp`, fitted under 4 MB, and kept like any file
  (sealed, §11 "Files"), in the conversation. It isn't made after something
  read was flagged, nor after other people's words when the owner's message
  didn't plainly ask (`lib/ask-guard.ts`). Undo archives it, like everything
  else (owner, 17 Nov 2026): the conversation's link to the file is archived
  (`thread_files.archived_at`, migration `0078`), so it leaves the
  conversation, can't be changed, and waits on the Archived page. Restore
  puts it back; delete for good is the app's own
  (`DELETE /api/pictures/:thread/:file`), and the file goes only if no note
  or other conversation has it. `GET /api/pictures/archived` takes the
  master token or a full key, like `GET /api/archived`.
- **From a Shortcut** (`/api/assistant/capture`) it has five filing tools
  and nothing else, and answers with a fixed line (§5, "What a capture can
  do"). A capture has a loop of its own (`runCapture`), which takes no
  mail, Slack or calendar port and reads nothing; it doesn't go through
  Ask's.
- **Undo:** every change comes back with an undo, one per change; a change
  to many records at once is one change with one undo. Undo archives what
  was created, puts back exactly what a change replaced (a person's fields,
  an item's, a to-do's, a reminder's, a field's name, type, options, unit,
  order and the values a change rewrote, a trip's, a booking's or an
  order's fields; a booking added to your trip also gives the trip its
  dates back), takes a link away or back, takes a file off a note,
  or archives or restores again. It validates its input against a fixed list of
  operations, none of which deletes a record.
- **Prompt injection:** note bodies include text collected from email and
  meetings, so the system prompt tells Claude that note content is data and
  only the owner's messages are requests, and the guard above backs it. A
  note already in Athena doesn't count as "other people's words" for the
  second rule (only an account's live result, a web page or a file does),
  so for a turn that read only Athena the worst outcome is as it was: a
  wrong change in Athena, which shows up as a receipt with
  Undo, or a card the owner would still have to tap. A link in the reply
  can't carry anything out either: links Athena wrote are never fetched
  (§11, "Link previews and embeds").
- **Jev's injection check:** before Claude reads any text from a connected
  account (in collections) or a note's full body (in Ask), Jev
  (`lib/jev.ts`) estimates whether it's trying to instruct an AI. Above 0.7,
  the text goes to Claude with a warning that it's someone else's data and
  must not be acted on. It's a second line of defence; the tool restrictions
  above are the first. If Jev is unavailable, text passes through unchanged.
- **@ mentions:** `GET /api/mentions` needs the master token or a full key,
  like the rest of the API; sealed titles are opened in the Function and only
  title, a short subtitle and (for a saved image) its `/api/saved/:id/image`
  address go back. A message's mentions are resolved on the server from their
  ids, never from what the client says they are; the `<mentioned>` block goes
  through Jev's injection check (a saved page's title is someone else's words)
  and is marked as data. An id that no longer resolves is listed as not found,
  and the model is told not to pick a lookalike.
- **Cost:** `/api/assistant` enters through the Netlify Server
  (`netlify/server/`), which allows 20 requests a minute per IP, counted in
  code, and answers 429 past that, behind the same bearer token as the rest
  of the API.
- **Runs** (`netlify/server/assistant/runs.ts`). A streamed reply carries on
  after the app goes away and is kept for the app to pick up: in the
  instance's memory, and in the `athena-ask-runs` blob store as one record a
  run (its steps, its words, the reply), sealed with `ATHENA_DATA_KEY` like
  the owner's files and deleted after its second day. Without the key
  nothing is written. Following or stopping a run
  (`/api/assistant/runs/<id>`) needs the same token as `/api/assistant`; the
  id is a UUID the app made. A run that's known is never started again. The
  loop makes its one change last, and the record says a change is coming,
  and is written, before it's made: a run lost before that changed nothing
  and may be started again; one lost after it never is, and the app gets
  what it had changed. If the store can't be read, the run goes ahead told
  to make no change (anything it would change comes back as a plan). Stop
  is checked before the change too.

### Assignments, Team chat and documents (migration `0076`)

Design in `docs/team.md` "Assignments"; notes in
`docs/team-notes/assign-integrate.md`.

- **Sealed.** `team_assignments.payload` (title and brief),
  `team_stages.words` (task, handoff, questions, answers) and
  `team_posts.body` are sealed like other text and are in the key
  rotation (`lib/encryption.ts`). Statuses, checkpoints, positions and
  timestamps stay readable. A made file's bytes and name are sealed like
  any file's.
- **A stage is an ordinary Team run.** The allowlist, the web rule, the
  time and turn limits and the held-run rule all apply. A guest's
  allowlist is empty apart from `hand_off` and the stage's `ask_owner`,
  which change nothing outside the assignment: `hand_off` writes only the
  assignment's own note. Any other change waits as a plan for the owner's
  approval, whatever the checkpoint or the suggestions setting.
- **Other people's words don't travel as instructions.** The brief, the
  work and every handoff reach a stage quoted as data. A stage that read
  other people's words (a web page) is held, and so is every stage after
  it; what they pass on is checked by Jev. A flagged turn's `work` isn't
  written to the note. Assistants never read Team chat.
- **Only the runner moves work on.** An assistant can't call another, and
  `start_assignment` and `continue_assignment` are main Ask's only. Both
  are write tools to the guard (`TOOL_ASKS`), so neither is offered once a
  turn is flagged. `continue_assignment` may approve a checkpoint or take
  suggested answers; it never approves a plan and never starts a
  lineup.
- **Limits.** 6 stages, 3 assignments running or waiting, 3 questions a
  stop and two stops a stage, one send-back by a stage per assignment
  (the owner's own aren't limited), a 2,000-character handoff.
- **Team chat.** Every route is behind the bearer token. What's typed
  (`POST /api/team/chat`) calls a model, so it counts against Ask's 20 a
  minute per IP (`netlify/server/routes/team-chat.ts`); reading the channel
  isn't counted. A typed reply answers a stage only when it has one open
  question; the suggestions phrase is matched only inside a thread, never
  on a message with a question mark or a "don't". An "@Name" turn gets no
  channel history.
- **The download route.** `GET /api/files/:id/download` is the file route
  with `Content-Disposition: attachment` and the file's own name
  (`filename` and `filename*`): the same bearer check, `nosniff`,
  `no-store` and sandboxing CSP. It adds no way to a file that
  `GET /api/files/:id` didn't already give.
- **`make_document`.** Reads one of the owner's own notes and writes a
  file on that note; it sends nothing anywhere. It's a write tool (not
  offered in a flagged turn, a plan step outside an allowlist), with a
  receipt and Undo, and Undo can delete only a Markdown or Word file on
  that note. A `.docx` is kept only when Athena made the bytes; an
  uploaded one is still refused. Ask doesn't read a made `.docx` back.
- **Deleting.** An assignment's stages, guests and posts go with it; its
  note is kept. A post outside an assignment is swept after 90 days once
  settled.

### Flows (migration `0080`, `lib/flows.ts`, `lib/flow-run.ts`)

A flow is a trigger and steps with branches (contract: `lib/flow-types.ts`).
It runs unattended, so it is held to the same rules as a Team run and adds
none of its own.

- **Sealed.** `flows.payload` (name, trigger, steps) and `flow_runs`'
  `label`, `summary`, `error` and `state` are sealed like other text and are
  in the key rotation (`lib/encryption.ts`). What the jobs need stays
  readable: the trigger's kind and a schedule with no words in it, a run's
  status, times, and ids.
- **Only Ask's own tools, and never one that leaves Athena.** A tool step runs
  one of Ask's tools with the same code and checks (`runAssistantTool`, or
  `ReadTools` for the shared looks). The catalogue (`lib/flow-catalog.ts`) is
  an allowlist: looks, changes inside Athena that keep an Undo, and drafts.
  Nothing that sends (messages, invite answers, notes to another service),
  edits a connected account (calendar moves and new events), deletes or
  archives, reshapes the owner's data (fields, types, mass edits), or only
  prepares a card for a tap. The store refuses a flow naming any other tool,
  and the runner checks again before every step.
- **Changes wait unless the owner said otherwise.** Only adding a reminder, a
  to-do or a list item runs alone by default (`AUTO_BY_DEFAULT`, which the
  editor, drafting and suggestions all follow); every other change, filing a
  saved item included, waits for approval unless the owner sets it to run alone. A change that waits is kept as an
  Ask plan (`ask_plans`, sealed) and nothing is made until the owner approves, which runs it
  through Ask's plan code, logged in What Ask did (a plain flow's as "Flow:
  <name>", with the flow's and run's ids, plain) with its Undo. Skip and Stop
  close the plan so it can't run later.
- **Drafts are never sent.** `draft_email` and `draft_message` always wait
  for approval: the store refuses one set to run alone, and the runner waits on it
  whatever was saved. Approving writes the draft with Ask's own code and the same
  mail and Slack ports Ask gets, and keeps it as a change for the owner to
  read. Nothing is sent, and an email reaches Gmail or Outlook Drafts only
  when the owner taps Save in the app (as for Ask, security review M7). With
  no email account to keep it in, the step stops and says so.
- **Money.** `money` and `regular_payments` run only while the flow's own
  switch and Settings' "Let Ask read transactions" are both on; otherwise the
  step is skipped and no amount reaches anything.
- **Thinking steps are the assistant's turn.** A Think step is
  `runAssistantTurn` in run mode: the assistant's persona, memory, allowlist
  and web switch, the guard on other people's words, its own spend cap. The
  values earlier steps found reach it quoted as data. Anything outside its
  allowlist waits for approval. A plain flow has no thinking steps (they're
  skipped), so it calls no model, apart from an assignment's lineup.
- **Assignments.** Start an assignment keeps the lineup as a draft; nothing
  starts until the owner approves it in Team chat.
- **A try changes nothing.** A dry run runs looks only; every change says
  what it would do, no card is sent, a thinking step is a read-only check,
  and the walk ends at a question.
- **Loops and limits.** A run keeps the ids of the records it changed
  (`flow_runs.made`, at once, not at its next save). An event about one of
  them is traced to that run: the new run records it (`started_by`) and the
  flows before it (`chain`, plain ids), and isn't started when its flow is
  already in the chain or the chain would pass three runs. A trigger's slot
  starts a flow once (a unique index). `FLOW_LIMITS` holds on save (40
  flows, 24 steps, 3 deep, 2 to 4 choices, 500 characters a piece of text,
  60 days a Wait); 50 runs are kept per flow; a run waiting for the owner 14
  days is stopped.
- **Values.** What the trigger and each step gave is kept in the run's
  sealed `state` and read back as plain words on every run read (a record as
  its title), for the owner's own app only.
- **Cards.** A Notify step's card, one saying a run waits for the owner, and
  an assistant's "From <Name>" go through the same gate as every nudge
  (mutes, quiet hours, the daily cap), sealed in `nudges`. A plain flow's
  follow the Flows switch (rule `flow`); an assistant's follow Team's.
- **Routes.** `/api/flows/*` is behind the bearer token like the rest of the
  API; the background function at `/api/flow-run` checks the same token.

### Flows' triggers (migration `0081`, `lib/flow-triggers*.ts`)

- **Plain, and only ids and times.** `flow_trigger_fires` keeps one row per
  fire a flow claimed: the flow's id, a key made of a kind, a record's id
  and sometimes a time (one flow's run for one event is `event:` and the
  event's id), and timestamps, never a title. Rows go after a week, and
  with their flow when it's deleted. `team_events.flow_claimed_at` is a timestamp beside Team's
  `processed_at`, set once every flow has had the event, so flows and Team
  each read events apart.
- **Nothing leaves the site.** Triggers read the calendar, People, life
  admin, orders and bookings from Athena's own tables and hand what they
  found (titles, names, dates) to the flow engine as a run's starting
  values and label. Sealing those is the engine's, as it is for a Team
  run's: they're kept only in the run's sealed `state`. A sealed title this deploy can't read is left out, never passed on.
- **Each fire runs once, and never late.** A fire is claimed before its run
  starts, so overlapping passes can't start it twice; one more than 90
  minutes late is skipped, a "before" is never run once its event has
  started, and nothing fires for a time or an event from before the flow
  was made.

### Assistants' triggers are flows (migration `0083`, `lib/team-flows.ts`)

Every Team assistant's trigger becomes a flow it runs, and Flows is the one way
anything runs on a trigger. Nothing new leaves the site and no new kind of data
is kept.

- **What moves, and how.** The reminders job turns each `team_triggers` row
  into a flow with the same trigger, the assistant's id, origin `trigger`,
  paused if the trigger was, and one think step: the assistant's job, run as
  a Team run always was (its instructions, memory, allowlist, web switch and
  spend cap; `runPrompt`'s words, with what arrived quoted as data). The
  flow's words are sealed in `flows.payload` like any flow's, so the move is
  code with the data key, not SQL. It runs in one transaction: either every
  trigger moves or none does, and a trigger that didn't move keeps firing as
  before. The trigger's last schedule slot is kept as a claimed fire
  (`flow_trigger_fires`, ids and a time), so a slot that ran isn't run again.
- **Never both.** A moved trigger is marked (`team_triggers.moved_at`) and
  never fires again; Team's pass claims a slot only while it isn't moved, and
  checks under a row lock, in the transaction that queues an event's run, that
  the trigger hasn't moved. An event Team claimed before a job flow was made
  (`processed_at` before the flow's `handed_at`) stays Team's; one Team
  couldn't run because its trigger moved is claimed again after the move, so
  the flow has it. The trigger rows are kept (old runs name them).
- **New plain columns.** `flows.trigger_id` (the trigger a flow was made from,
  unique), `team_triggers.moved_at`, and `team_runs.flow_id` and
  `flow_run_id`: ids and a time. A settings row (`team.triggers_moved`) says
  the move finished, with counts.
- **One record of a run.** A run of an assistant's flow is kept as that
  assistant's `team_runs` row (sealed label and summary, as before), linked
  by the flow run's id; the engine no longer writes a second, quiet one. A
  failed run's line in `team_runs.error` is Team's own fixed words
  (`failLine`), never the flow's, so that plain column holds no owner's words.
  Its "From <Name>" card goes through Team's delivery and the same gate; the
  flow sends no card of its own for the same thing. A paused assistant's flows
  don't run, handed ones included: a run queued or waiting when it was paused
  stops when it's picked up, with no turn, card or post. Run now still runs.
- **Tried once more, never twice a change.** A failed run of an assistant's
  flow is queued once more only when nothing ran: no change recorded, no plan
  kept, no card owed, no step run that changes things (even one that then
  failed), no assignment drafted, and a failed turn that left nothing in its
  conversation (the same `ask_activity`/`ask_plans` check Team's retry uses).
  Anything unexpected counts as something ran. So a retry can't repeat a
  change. Only once (`RunState.retried`, `team_runs.retried`).
- **Think steps.** A think step's values come back as structured fields of the
  assistant's answer (the answer tool's `values`), not parsed from its text.
  A step with `web: false` runs the assistant's turn with its web switch off:
  no search, no page and no tracking rule, whatever the assistant's own
  setting.
- **Approve from Ask's plan card.** Approve on a plan a flow's run waits on runs the
  run's own approval (as on the run page): a draft is written with Ask's draft code
  and kept as that run's change; nothing is sent.
- **Sharing.** A shared assistant's file is unchanged: its flows' triggers in
  the same shape older copies read, with no flow ids. An imported assistant's
  triggers become paused flows (origin `shared`) that come on when the owner
  turns the assistant on.

### Drafting flows and Ask's flow card (`lib/flow-draft*.ts`)

- **What goes to the model.** `POST /api/flows/draft` and Ask's
  `propose_flow` send the owner's one sentence (1,000 characters at most),
  today's date, and the names, first lines, field names and the names of
  the values each gives of the tools a flow may use, to the model the owner chose for drafting (the `team_draft`
  job, docs/ai-models.md). No notes, people or other records go with it. The
  sentence is quoted as data, and nothing is saved by drafting itself.
- **Checked, not trusted.** What the model proposes is checked against
  `lib/flow-types.ts` and `FLOW_LIMITS` before anything sees it: unknown
  tools are dropped with a note. Only the engine's step catalogue
  (`lib/flow-catalog.ts`, the same list the Add a step sheet offers) is
  offered, so never a tool on its `NEVER_TOOLS` (those that send, answer for
  the owner, change a connected account, archive or delete, or reshape the
  owner's data). A drawn step gives only the values the engine fills for
  its tool. Values may only
  point at the trigger or at a step that has surely run before. A step that
  reads spending is kept only while "Let Ask read transactions" is on.
- **Changes wait for approval.** A drawn change runs alone only if it's a
  reminder, a to-do or a line on a checklist (each only adds to the
  owner's own Athena, with Undo) and the owner didn't ask to be checked
  with; every other change waits for approval. A draft step (`draft_message`,
  `draft_email`) always waits for approval, whatever the model says, and only
  writes a draft for the owner to check: nothing is sent. Thinking steps
  are left out: a drawn flow has no assistant.
- **Saved off.** `propose_flow` saves the flow paused (`origin: "ask"`)
  through the engine's `FlowCreator`; nothing runs until the owner taps
  Turn on (`PATCH /api/flows/:id`, the engine's route and checks). It's
  main Ask's only, never an assistant's turn or a stage, never a plan step,
  one per reply, and a write tool to the guard, so it isn't offered once a
  turn is flagged.

### Plans, routines and What Ask did (migration `0055`)

- **Plans write nothing until Approve.** While Ask works, every tool that could
  change something is handed to a `PlanDraft` (`lib/ask-plans.ts`) instead of
  running. One queued change runs when the model finishes, as before. Two or
  more are kept as an `ask_plans` row, steps and tool inputs sealed under the
  data key (§11), and the app gets the step lines only, never the inputs. Approve
  (`POST /api/assistant/plan`, rate-limited with the rest of Ask) runs the
  owner's ticked steps once: `ran_at` is claimed first, so a second tap or a
  second device runs nothing. Each step goes through the same tool code and
  checks as a reply. A move, which in a reply waits for the confirm sheet,
  is made at Approve, since Approve is that tap. Stand-in ids are only ever swapped for
  ids the plan's own earlier steps made.
- **Routines can read, and only propose.** A routine (`ask_routines`, words
  sealed; days and time plain so the scheduler can read them) runs as the
  owner's own message through Ask's one loop (§10, "Ask's answers"), with
  the same read tools, Jev checks, guard and money switch, in "propose"
  mode: every tool that could change something is queued and
  nothing is run, even a single change, and the plan waits for the owner's
  approval. A routine never writes to Athena or a connected account, never sends
  anything, and keeps only its Ask conversation and its nudge (both sealed).
  At most 10 routines; each slot is claimed once in the row (`last_slot`); a
  run gets the loop's caps (10 model calls, 24 lookups, 120 seconds; once it
  queues a change, 14 calls and four minutes), in a background function
  behind the bearer token.
- **Delivery.** A run's nudge (rule `routine`) goes through the shared gate:
  daily cap, quiet hours (it waits in the sealed `pending` column until they
  end), and the switch in Settings → Notifications. Its push carries the
  routine's name and the answer's first line, like any nudge's title and
  body, and opens `/#/ask/nudge/<id>`.
- **What Ask did** (`ask_activity`, `lib/ask-activity.ts`). One row per change
  from a reply, a plan, a routine's plan, a nudge card's part or a flow's
  step. The receipt and its Undo op are sealed in `payload`; readable columns
  are ids (a flow's row also the flow's and run's, migration `0080`), the
  source, the state and times. A flow's name for its label is read from the
  flow's sealed words, never copied into the log. Undo there is the same `applyUndo` as a
  reply's; a refusal is kept as "couldn't undo". A nudge part's words come
  from Athena's own stored nudge, and only a move's own undo op is taken
  from the app (a to-do's is built on the server).
- **Something to watch tonight** reads only the owner's own Watch & read
  films and shows (Trakt's watchlist lands there), their ratings and what they
  told About you. No search and no model call; every pick is an item already
  on their list. Off by default.

### Skills (migration `0058`, `lib/skills*.ts`)

- **Instructions only.** A skill adds no tools or permissions. The tool list
  is the back end's own plus `use_skill` and `read_skill_file`, which only
  read the owner's own skills and are run by the back end, never queued in a
  plan. Writes still wait for approval, money search is still refused in
  `ReadTools` while it's off, and Ask has no tool that sends anything. The
  prompt says a skill can't override these rules, and
  `lib/skills.db.test.ts` checks it with a skill that says to send, skip approval
  and read transactions.
- **Sealed.** Each skill's text, files and source are one sealed JSON string
  in `ask_skills.payload` (§11), re-sealed on key rotation. Readable columns:
  the switch, the starter key, the use count and times.
- **Imports.** Nothing is saved without the owner: every upload, folder, zip
  and link is a preview of the whole text and files first, and keeps where it
  came from. One from a file or a link is saved off, whatever the request
  says (`createSkill`); the owner switches it on from its page. Zips are read from the central directory with each text entry
  inflated to at most 100 KB; uploads are capped at 2 MB; paths with `..`,
  hidden files and anything but .md .txt .csv .json are dropped or listed as
  not used. Scripts are never stored or run.
- **Links.** Fetched once, on the server, through the same guard as Saved
  (`publicFetch`, `assertPublicHost`): https only, no credentials in the
  link, public addresses only (checked before and while connecting),
  redirects followed by hand and only on the same host, 12 seconds, 100 KB a
  file and 2 MB in all. GitHub folders go through `api.github.com`'s contents
  API without a token (public repositories only); files are fetched only from
  `raw.githubusercontent.com` as its listing names them.
- **Text from others.** A skill the owner wrote (or a starter) is the
  owner's chosen instructions and is marked as a skill in the prompt. One
  from a file or a link is someone else's words: it goes in as
  `<shared_skill>` with `SHARED_SKILL_RULE`, to weigh, never as the owner's
  instructions, and while it's in use the turn opens only the accounts
  ticked for it (below, "Items someone else shared"). Reference files may be
  someone else's words and go through Jev's check like any tool result.
- **Drafts.** "Make this a skill" sends the conversation's text (no files) to
  the model through `/api/assistant/skill-draft`, rate-limited with the rest
  of Ask. `lib/skill-draft.ts` has no store: the draft only opens the editor.

### Sharing and importing assistants (`lib/team-share*.ts`)

An assistant can be downloaded as a file (a zip of `assistant.json`,
`SKILL.md` and the skill's files) and imported into another copy. Migration
`0087` records that an assistant was imported and the accounts ticked for it
(ids only).

- **Nothing leaves unless the owner downloads it.** `POST
  /api/team/<id>/export` (bearer token) builds the file in memory and sends
  it only to the owner's own device. Athena never uploads or publishes it,
  and there's no public page or link to the site: sharing is whatever the
  owner does with the file (a message, their own GitHub repository, a pull
  request to a catalogue).
- **What goes in.** The assistant's name, job, instructions, character,
  triggers (days and times; event filters), its skill's text and files, and
  as requests only: the tools it may run alone and whether it looks things up
  online. What never goes in: its memory, runs, conversations, model
  choices, connector ids, the owner's setup answers (only the questions), and
  any id. Edits made in the share sheet change the file, never the assistant.
- **Taken out, then checked.** Before the owner sees it, `scrubText` removes
  `athena://` links, links to the site's own hosts (the request's, and
  Netlify's `URL`, `DEPLOY_URL`, `DEPLOY_PRIME_URL`) and record ids.
  `findPersonal` then flags whole-word matches of the owner's people (names,
  first names written as names, nicknames, email addresses, phone numbers),
  places and first address lines, organisations, projects, their own name,
  home town and employer, and connected account labels, plus any email
  address or phone number not on an example domain or Ofcom's drama range,
  and links to hosts that are usually private (Google Docs and Drive, Notion,
  Slack, Linear, Zoom, `*.netlify.app` and others). These are opened and
  compared in memory and never kept or sent. The download is refused (409)
  while anything is flagged and not marked fine, and the server checks again
  on every download. The check catches slips but can miss things it
  doesn't know about, such as a nickname Athena has no record of, so the
  sheet asks the owner to read the file through.
- **Importing one treats every word as someone else's.** `readShared` checks
  every field against the same limits as an assistant made in Athena, drops
  unknown keys and looks it can't draw, and refuses anything else with a
  message. Zips and folders go through the same intake as skills (§10,
  "Skills": central directory, 2 MB, 100 KB a file, text files only, no
  scripts kept). Links are GitHub only (`github.com` folders and files, or
  `raw.githubusercontent.com`), fetched once through the same guard as skill
  links; links to any other host are refused, so a shared assistant can't point
  Athena at someone's own site. The preview (`POST
  /api/community/preview`, below) keeps nothing.
  `POST /api/community/add` adds it.
- **Nothing in the file is a permission.** The assistant joins paused.
  `allow` is only the tools the owner ticked that the file also asked
  for and that an import may grant at all (`grantedTools`, `SHARED_TOOLS`
  in `lib/shared-limits.ts`: changes inside Athena that keep an Undo, as the
  flows catalogue's "add" group, plus `track`), each unticked to start.
  Anything else the file asks to do alone is shown as "Always asks first"
  and isn't stored. `web` is on only when both
  the file asked and the owner ticked it. It opens no connected account
  until the owner ticks it (below). Everything else waits for approval,
  as for any assistant (§10, "One loop"). The skill is an assistant's own
  skill: instructions only, no tools (§10, "Skills"). Sites its words link
  to are listed on the preview as unchecked.
- **The installed app's share target** takes a shared item (a `.zip`,
  `.json` or `.md`, up to 2 MB) only from the OS, as for any share
  (`shareFrom` in `sw.js`); another page's form is refused. It's kept in
  Cache Storage until the Add screen (`#/add`) reads it, and that screen
  shows all of it before anything is added.

### Items someone else shared (migration `0087`, `lib/shared-limits.ts`, `lib/shared-scope.ts`)

An imported assistant, and a skill from a file or a link, are someone else's
words. They reach only what the owner ticked for them, enforced in code.

- **Recorded, not guessed.** An assistant is imported when its row says so
  (`team_assistants.origin = 'shared'`, set by `importAssistant`, now reached through `POST /api/community/add`; the
  migration marks those whose triggers became flows with origin `shared`)
  or its own skill came from a file or a link (once, in code, since that is
  sealed). A skill is imported when its sealed source is `upload` or `link`,
  so skills imported before `0087` are held too.
- **Accounts only when ticked, per account.** `team_assistants.accounts` and
  `ask_skills.accounts` are connector ids, plain, empty to start, kept only
  for accounts that exist. An imported assistant's chats, runs, checks and
  flow steps (`runAssistantTurn`), and any turn while an imported skill is
  in use (picked with "/", or loaded with `use_skill` or `read_skill_file`),
  carry an `AccountScope`. Accounts outside it aren't opened when it's known
  before they open (`SourcesPort.open`'s `only`), their tools stop being
  offered, a call to one is refused, and the Session's mail, Slack and
  calendar ports refuse them (`scopedPorts`; a calendar look outside it
  finds nothing). A custom MCP server with "Use in Ask" is an account like
  any other. Two limits leave only what both allow. A skill brought into use
  part way through a turn can't take back what was read before it.
- **Approve keeps the limit, and asks** (owner, 24 Nov 2026). A plan records
  who limits it (`ask_plans` payload `limit`, sealed, ids only): the
  imported assistant that proposed it, and each imported skill in use when
  main Ask (or an assistant) made it. Approving it runs under all of their ticks
  together (`goPlan`, `limitedForGo`): a step that needs another account is
  refused before the account is reached, and the plan stops there. The card names
  the account in Athena's words, never the model's. For an assistant it
  offers Just this once (that approval only; nothing is kept), Always for the
  assistant (ticks it) or Skip it. When a skill is what refused it, the card
  names the skill and offers only Just this once and Skip it, with a link to
  the skill's page; the server refuses Always for a skill, so a skill's
  accounts are only ever ticked on its page. A plan whose assistant or
  skill was removed is held the same way, with no ticks.
- **A refused step always stops** (owner, 24 Nov 2026). Some steps carry on
  without an account they were refused (a draft written without reading
  the earlier thread). Any step refused an account stops the plan and asks,
  however it ended. What it made without the account is undone and never
  kept in What Ask did or shown as done; if an undo fails, that change is
  kept in What Ask did so the owner can see it and undo it there.
- **Needed accounts said plainly.** Ticks still start empty. The accounts
  the file says it needs are kept with the assistant's sealed words, listed
  first, and while one is unticked the Add screen and the assistant's
  page say it can't work without it.
- **Framed as someone else's words.** An imported assistant's instructions
  and skill go in as `<shared_instructions>` and `<shared_skill>` with a
  rule that they are suggestions to weigh, never the owner's requests;
  `lib/team-chat.ts` and `lib/skills-ask.ts`. A check-in question added
  from someone else's set goes to Go deeper's model as `<shared_question>`
  with a rule of its own (`lib/checkin-deeper.ts`; Community, below).
- **Seen and changed by the owner.** One tick per account on the import
  sheet (the accounts the file needs first), an imported assistant's page and
  an imported skill's page. After `0087`, Home names each imported skill that
  had none ticked, once (`GET`/`DELETE /api/skills/notice`; settings
  `skills.accounts_notice` holds ids only).
- **A model's words in the owner's note link plainly.** Every tool through
  which a model writes into a note the owner wrote (`save_note`,
  `add_to_list`, filing a saved item onto a list, an assignment's work, the
  MCP `update_note`) goes through `modelWroteInto` (`lib/links.ts`): links
  it adds lose their card, mention or embed mode, so nothing it writes
  makes Athena fetch a page. Modes the owner had already chosen stay. This
  holds for agents writing over MCP too, a Claude only key included, on
  purpose (owner, 24 Nov 2026): an agent's words are a model's words, so a
  link it adds to the owner's note stays plain until the owner changes it.
- **Decided as built** (owner, 24 Nov 2026). What a shared assistant may be
  granted stays the flows catalogue's "add" group plus `track`. Assistants
  imported before 0087 that left no record are not limited. An imported
  skill limits a turn from the moment it is used, and stays imported after
  the owner rewrites it. The one-time notice stays a Home card, and sample
  mode's Dot keeps its extra asks.
- **Tested** (`lib/shared-limits.test.ts`, `lib/ask-plans.test.ts`, `lib/shared-items.db.test.ts`).

### Community (migrations `0089`, `0090`, `0091`, `lib/community-*.ts`, `lib/flow-share*.ts`, `lib/checkin-share.ts`, `lib/checkin-sets.ts`, `lib/template-share.ts`, `lib/templates-db.ts`, `netlify/lib/community-*.ts`)

Shared assistants, skills, flows, check-in questions and note templates are
someone else's words. They reach Athena through one screen (`#/add`) and two
routes, behind the bearer token. Assistants, skills and flows start switched
off; check-in questions join the owner's own but never switch a check-in on;
a template joins the owner's templates and does nothing by itself. Nothing in
a file is a permission.

**Reading the catalogue: what leaves the site.**

- **Which host.** The Community site, `athena-community.netlify.app`
  (`COMMUNITY_SITE` in `lib/community-site.ts`), unless the site's owner sets
  `ATHENA_CATALOGUE_URL` to another catalogue, or to `off` for none.
- **Only the server, only the catalogue's files.** Athena's server reads
  `index.json` and an item's bundle (`bundles/<id>.json`) from under the
  catalogue's root (`netlify/lib/community-catalogue.ts`), through
  `publicFetch` (https only, every address checked as it connects). Each
  request is a plain GET with `Accept: application/json` and nothing else:
  no site address, account, API key, cookie or token, and no body. What the
  host can see is what any web server sees: a request from Netlify's
  servers, when, and which file, so a bundle read tells it that some copy of
  Athena opened that item. It may count those reads as downloads; nothing in
  them names the owner or their site. A redirect is followed only while it
  stays under the catalogue's root, and `catalogueFileUrl` refuses a path
  that leaves it. The browser never contacts the catalogue.
- **How often.** The index at most once a day (kept in the `community` blob
  store, plain: it's the catalogue's public list), and a bundle only when the
  owner opens an item. The daily check (`netlify/functions/community-check.ts`)
  and the update check fetch nothing while nothing from the catalogue is
  added.
- **The switch.** Nothing is fetched until the owner opens Community: the
  switch is off until then, so a new copy contacts the site for nothing.
  Opening Community the first time switches "Check the Community catalogue"
  on (the owner's decision); the page names the host beside the switch, and
  Settings → Ask has it too. Off means no request at all: no browsing, no
  update or withdrawn checks. Adding from a file or a link still works.
- **Submit to Community sends nothing.** The share sheets say how to submit
  (the folder in a public GitHub repository of the owner's, then shared on
  the site) and open the site's `/submit/` page in the browser, with
  `rel="noopener noreferrer"`, so the site isn't told which Athena sent the
  owner. Athena never publishes anything. The page's address comes from
  `GET /api/community/settings`, which doesn't contact the site.
- **A download count is the site's word.** `downloads` on an index item is
  shown rounded and used to order the list, nothing else; it's checked as a
  whole number within a cap, and an index without it reads as before.
- **Only fields Athena knows are kept.** A key it doesn't know, on the
  index, an item, a withdrawn entry, a bundle, a bundle's file or a listing,
  is dropped as the file is read (`lib/catalogue-types.ts`): never stored,
  shown or passed on. Every known field keeps its type, size and count
  checks, and one that doesn't fit refuses the whole file. The bundle hash
  covers each file's path and text, so an extra key can't carry changed
  words past it.
- **A kind Athena doesn't know is skipped.** An index item whose `kind` is a
  word this copy doesn't know (a kind added after it was built) is left out
  as the index is read, and the rest is read as usual: never shown, fetched
  or added. A known kind that doesn't fit, or a `kind` that isn't a word,
  still refuses the index.
- **A withdrawn item is paused once** (assistant or flow paused, skill
  switched off, a set of check-in questions switched off so its questions
  aren't asked) and remembered in the plain settings row `community_paused`,
  so switching it back on sticks. Nothing is deleted or updated by itself. A
  template does nothing by itself, so nothing is paused: it stays as it is,
  with the catalogue's reason shown in its editor, until the owner removes it.
- **Plain columns.** `catalogue_id`, `catalogue_hash` and `catalogue_version`
  on `team_assistants`, `ask_skills`, `flows`, `checkin_sets` and
  `note_templates` hold the catalogue's public id, a SHA-256 of the item's
  files as added and the author's version: nothing the owner wrote.

**Adding something someone shared.**

- **One preview, nothing kept.** `POST /api/community/preview` takes a
  listing id, a link, or files (multipart, 2 MB in all; one zip goes through
  the skill zip reader). Its files are cut down to the item's own folder,
  text only, within the catalogue's caps (32 files, 100 KB each, 500 KB in
  all), and read by its kind's own reader (`readShared`, `intakeEntries`,
  `readSharedFlow`, then `checkSharedFlowSteps`, `readSharedCheckins`,
  `readSharedTemplate`). Kind, reach and hash are
  worked out here from the files; the catalogue's or author's word for them
  is never used. A lone file renamed on the way is read by what it holds.
- **Links** are GitHub only (`parseShareLink`, a `flow.json`,
  `checkin.json` or `template.json` read as its folder), fetched once through the same guard as skill links. Any other
  host is refused, so a shared item can't point Athena at someone's own site.
- **Catalogue listings.** A bundle is checked with `verifyBundle` against its
  own hash and the index's before it is read.
- **The server never trusts the preview it sent.** `POST /api/community/add`
  reads the files the app sends back again and refuses them if their hash
  differs from the preview's. For a listing it fetches the bundle again and
  refuses it if it changed since the preview. A preview relabelled as
  another kind is added as what its files are.
- **Switched off, with only the owner's choices.** An assistant goes to
  `importAssistant`: paused; tools ticked that it asked for and an import may
  grant (`grantedTools`, `SHARED_TOOLS` in `lib/shared-limits.ts`); the web
  only when asked for and ticked; ticked accounts only; "Always asks first"
  for the rest. A skill goes to `createSkill`, always off, ticked accounts
  only. A flow goes to `addSharedFlow`, paused, every question answered
  first. Account ticks start empty; the accounts it needs are listed first,
  and an unticked one is named as one it can't work without.
- **Already added** (owner, 24 Nov 2026). The preview says "You already have
  this" for an item added from the same listing. Update (`choices.replace`)
  replaces only the item the server itself finds came from that listing,
  never another id the app names, and only for a catalogue item. It goes
  through the same reading and the same choices as an add, keeps the item's
  name and history, and switches it off. A second copy is a separate,
  deliberate tap.
- **A file for a newer Athena** is refused with 426 and nothing is read
  further. Team's old `/api/team/import`, `/api/team/import/preview` and
  `/api/skills/preview` are gone (owner, 24 Nov 2026).

**Shared flows** (`lib/flow-share.ts`, `lib/flow-share-store.ts`).

- **What a shared flow carries.** Its name, a summary, its trigger and steps,
  the questions it asks whoever adds it, the accounts its trigger needs, and
  whether it would like to read spending or search the web. A flow added
  from Community also names its listing's public page as `based_on`: the
  catalogue's own id, nothing of the owner's. A `based_on` is kept only when
  it's a github.com link or a listing on the Community site; anything else in
  a file is dropped. Never its id,
  runs, values, the assistant it was handed to, or a record id: steps are
  numbered afresh, and a step field that held one of the owner's records,
  list names or to-do contexts becomes a blank with a question ("Which
  list?", "Which context?"; owner, 24 Nov 2026). The owner's own list and
  context names never go in the file.
- **Checked before it leaves.** `POST /api/flows/<id>/export` takes links
  into the site and `athena://` links out (`scrubText`) and flags anything
  that looks like the owner's own people, places, addresses, email
  addresses, phone numbers or private links (`findPersonal`, the same terms
  as sharing an assistant). Nothing downloads until each finding is edited
  out or marked fine, and the server checks again on download (409 with
  what's left). A step that leans on the owner's own types or fields can't
  be exported, and the sheet names it. The drafted summary uses only
  Athena's words for the trigger and steps (`draftSummary`, no model): what
  a trigger matches and step titles are left out. The edits change the
  file, never the flow. The terms are compared in memory, never kept or
  sent.
- **Adding one grants nothing.** `addSharedFlow` reads the file again
  (`readSharedFlow`, `checkSharedFlowSteps`), whatever the caller sends,
  then: step ids made here; every step that changes something waits for
  approval, whatever the file asked (steps that only look run, as in any flow;
  owner, 24 Nov 2026); thinking steps off the web; spending off; the flow
  off, origin `shared`. The owner's answers fill the blanks; an answer for a
  record must be one of their own ids. A blank left unanswered stays as an
  unfilled field, sealed with the flow (`flows.payload`), and until it is set
  the flow can't be switched on, run with Run now or tried (owner, 24 Nov
  2026). A shared flow with thinking steps can't be switched on until the
  owner hands it to one of their assistants. The result passes the same
  `checkSteps` as a flow made here.
- **Tested** (`lib/flow-share*.test.ts`, `lib/flow-share-store.db.test.ts`,
  `netlify/lib/community-*.test.ts`, `app/src/db/sample-community.test.ts`),
  with fakes for the stores, the catalogue and GitHub.

**Shared check-in questions** (`lib/checkin-share.ts`, `lib/checkin-sets.ts`,
migration `0090`).

- **What a set carries.** checkin.json, format 1: a name, a one-line summary,
  the optional header (`version`, `author`, `based_on`) and the questions.
  Each question carries its words, the routines it's asked in (morning,
  evening or both), how it's answered and, for that type, the slider's
  sentence and ends, the choices, or the empty box's hint and whether it
  offers Go deeper. Never an id, an answer, a day, a pin, a count a day, or
  where answers are copied to (`mirror`): a `mirror` in the file is dropped
  like any unknown key.
- **Read as someone else's.** `readSharedCheckins` checks every word against
  the owner's own question limits (40 questions, 200 characters a question,
  40 a choice, 30 choices), keeps one line of each, drops unknown keys and
  any field that belongs to another type of answer, and refuses an unknown
  type of answer with words naming the question.
- **Checked before it leaves.** `POST /api/checkins/share` takes only
  questions the owner wrote (not Athena's, not ones added from someone
  else's set), takes links into the site out (`scrubText`) and flags the
  owner's people, places, addresses, contact details and private links
  (`findPersonal`, the same terms as an assistant or a flow), in the name,
  the summary and each question. Nothing downloads until each finding is
  edited out or marked fine; the server checks again on download (409).
- **Adding grants nothing and switches nothing on.** `addSharedCheckins`
  reads the file again. Each question whose words the owner doesn't already
  have becomes one of their own and joins the end of each routine it's
  asked in, unpinned. Nothing already there moves or changes, a routine
  that's off stays off, and the screen says so. A question whose words are
  already here is skipped and named. Past 40 of the owner's own questions,
  the rest are left out and named. Under "When to start" the owner picks
  "Start asking them" (the default) or "Add them switched off"; neither
  switches a routine on (owner, 25 Nov 2026). An Update keeps whichever
  state the set was in.
- **Where answers go: Athena decides, by type** (owner, 25 Nov 2026), for
  a set's questions and the questions the owner writes alike.
  `ownMirror` (`lib/checkin-types.ts`) gives a question the `day_journal`
  mirror when Athena's own questions of that type go to the journal
  (written answers), and none otherwise (scale, choices, life areas). So a
  written answer to a shared question, or to one the owner wrote, is copied
  into that day's journal, sealed under the data key like the rest of the
  day, in the check-in's own section, swapped by exact text
  (`lib/checkin-journal.ts`): changing or undoing the answer changes or
  takes out the copy, as for Athena's own questions, and the owner's own
  journal text is never touched. The server sets this again whenever
  settings are saved or read (`readOwnQuestion`) and reads past any
  `mirror` sent, so neither a file nor a settings request can point a
  question at the day's mood, Health (energy, stress, mood words) or the
  briefing. A day's plan keeps its questions as they were asked, so days
  planned before this rule keep their answers out of the journal: nothing
  is back-filled and nothing already in a journal is rewritten. The journal
  stays in the owner's Athena: nothing new leaves the site. The Add screen's
  "Where your answers go", Settings → Check-ins and the screen for writing a
  question say so.
- **Stored plain, like the owner's own questions.** The questions live in
  the plain `checkins` settings row, each naming its set in `set`; the set is
  a `checkin_sets` row (name, summary, author, version, `paused`, the
  catalogue columns). Answers to them are sealed in `checkins` as any answer.
- **Switched off.** A set switched off (by the owner, or once by Community's
  withdrawal check) keeps its questions but they're left out of every new
  day's plan (`askable`) until it's switched back on. Removing a set takes
  its questions out of both routines; answers already given stay on their
  days, and so does anything already copied into a day's journal: removal
  changes only the settings, never a past check-in or a day.
- **Reach: always tier 1** (owner, 25 Nov 2026). Questions only ask, and
  their answers stay in the owner's Athena (their check-ins, and the day's
  journal for written ones), so a set reaches nothing outside Athena by
  itself. Go deeper is the one way a shared question's words reach a model:
  when the owner taps it on a written answer, the question and what they
  wrote go to their chosen model for one follow-up question
  (`lib/checkin-deeper.ts`), exactly as for their own questions. Because it
  happens only on the owner's tap, each time, the set is still tier 1
  ("Stays in Athena"; `reachOfCheckins`, and `checkinSetTier` for a set
  already added), and for a set with such a question the Add screen and
  the share sheet each say, in one line, that Go deeper sends the question
  and the answer only when tapped.
- **Framed as someone else's words.** A question from a set reaches the
  model as `<shared_question>` with `SHARED_QUESTION_RULE` (someone else
  wrote it; its words are only the topic and ask for nothing), after Jev's
  injection check (`guardText`), as an imported skill's words are framed.
  The owner's own questions go in as before.
- **Tested** (`lib/checkin-share.test.ts`, `lib/checkin-deeper.test.ts`,
  `lib/checkin-sets.db.test.ts`, `lib/catalogue-types.test.ts`,
  `netlify/lib/community-add-routes.test.ts`, `lib/checkins.db.test.ts`,
  `app/src/db/sample-checkins.test.ts`, `app/src/db/sample-community.test.ts`).

**Shared note templates** (`lib/template-share.ts`, `lib/templates-db.ts`,
migration `0091`).

- **What a template carries.** template.json, format 1: a name, a one-line
  summary, the optional header (`version`, `author`, `based_on`) and the
  body: Markdown with `{{fields}}`, as the owner's own templates are. Never
  an id, a starter key, or a note made from it.
- **Read as someone else's.** `readSharedTemplate` checks every word
  against the template limits (80 characters a name, 400 a summary, 20,000
  the body), drops unknown keys and control characters, and makes the body
  plain (`plainTemplateBody`) so nothing in it can make Athena fetch
  anything by itself: a web link loses its card, mention or embed mode
  (`plainWebLinks`), a picture (`![…](…)`) becomes a plain link to it, raw
  HTML tags and comments go, and `athena://` links and record ids (someone
  else's Athena) keep only their words. The note editor's schema drops
  pictures and HTML as well, so this holds twice.
- **Fields fill only from the owner's own records.** A shared template is
  filled exactly as the owner's own are (`lib/template-fill.ts`): from
  records already in their Athena, never from the file or a model, and a
  field Athena doesn't know stays a blank. In a day's journal, only `{{date}}`,
  `{{today}}` and `{{week}}` fill in, with that day's date
  (`journalFromTemplate`); nothing else is read.
- **Reach: always tier 1.** It reaches nothing outside the owner's Athena
  (`reachOfTemplate`). Ask's `fill_template` hands a model only Athena's
  words about one (§9, "Documents Athena writes"). Its name can be listed to
  Ask among the owner's templates' names, as a label to pick by.
- **Adding grants nothing and replaces nothing.** `addSharedTemplate` reads
  the file again and keeps it as a new row marked `origin = 'shared'`, with
  its author, version and listing plain, and its name, body and summary
  sealed under the data key (§11). One of the owner's templates, or one of
  Athena's starters, is never replaced or renamed: a name already in use
  gets a number on the end. An Update (`replaceSharedTemplate`) replaces only
  an added template the owner hasn't changed; once they've changed it
  (`changed_at`), theirs is left exactly as it is and stops following the
  listing, and the new version is added beside it.
- **Checked before it leaves.** `POST /api/templates/:id/share` takes only a
  template the owner wrote (not one of Athena's starters, edited or not, and
  not one added from someone else), takes links into the site and
  `athena://` links out (`scrubText`, a line at a time) and flags the owner's
  people, places, addresses, contact details and private links
  (`findPersonal`, the same terms as the other kinds) in the name, the
  summary and the body. Nothing downloads until each finding is edited out
  or marked fine; the server checks again on download (409). Notes made from
  it never go.
- **Removed like any template.** Removing one archives it, with Undo. Notes
  and journal pages started from it are the owner's and stay as they are.
- **Tested** (`lib/template-share.test.ts`, `lib/template-share.db.test.ts`,
  `lib/templates.test.ts`, `netlify/lib/community-add-routes.test.ts`,
  `app/src/db/sample-community.test.ts`).

### Ask's read tools, today's context and memory

`work` reads `work_items` and Work activity's notes: the owner's own work only, cited as the Work page for a period (`work:month`).

Both the assistant and the written answer get the same read tools
(`lib/ask-tools.ts`) and the same block about today (`lib/ask-context.ts`).
The owner decided (9 Nov 2026) that Ask may read all of their data when a
question needs it, so the model picks the tool and no keyword list gates it.

- **The read tools.** `goals`, `trips`, `purchases`, `habits`, `days`,
  `health`, `places`, `patterns`, `money`, `energy` and `regular_payments`. They only
  read, through the same lib functions as the app's pages, and they are the
  only path from `sensitive_blobs` to a prompt. What each returns:
  - `health`: figures by day (sleep and deep sleep, steps, active minutes,
    resting heart rate, recovery or recharge, workouts, weight on a weigh-in
    day, food and caffeine), with averages. Never a route.
  - `places`: place names and minutes by day, and the weather line. Never
    coordinates, addresses or ids.
  - `money`: each matching payment's day, time, merchant, amount and
    category, with exact totals. Never a balance; at most 400 days and 60
    payments a call. Offered, with `regular_payments`, only while "Let Ask
    read transactions" is on (§1, "Money and home"); `ReadTools` refuses
    both while it's off, so the rule is in code, not only in the prompt.
  - `weather`: the forecast from Open-Meteo, today and up to 15 days
    ahead (daily figures; for one day the hours from 07:00 to 22:00).
    Without a place, Open-Meteo gets the coordinates, rounded to 2
    decimals (about 1 km), of where the owner last spent a day in the past
    week, else of the Place called Home: the same as the Life log's
    weather already sends. With a place, its geocoder gets only the town's
    name as the model wrote it. No key, no account, nothing about the
    owner; nothing is kept. Past and out-of-range dates are answered
    without a request.
  - `energy`: House's Trends card (kWh a day by period, month totals for
    the forecast, £ when priced, gas allowing for the weather with each
    period's mean temperature). Never a half hour or a time of day, which
    would show when someone's home. It opens the home days and the tariff,
    never the bank days, and is offered whether or not "Let Ask read
    transactions" is on (owner decision, 10 Nov: energy use isn't bank
    data). A day read in full still drops its electricity line while that
    switch is off.
  - `days` for one date: the journal, mood, health line, places, weather,
    and the spending and electricity lines only while money search is on.
  - `trips` and `purchases`: bookings with reference and seat, orders with
    status and dates. Never a price.
  Results go through Jev's check like any other tool text and are capped at
  8,000 characters. Nothing they return is stored or logged.
- **Today's context.** Every Ask turn's system prompt carries a block of at
  most 2,400 characters: now and the zone; today's and tomorrow's events
  (time and title, never notes); last night's sleep, deep sleep, recovery
  or recharge and resting heart rate; to-dos due and a few open ones, with
  who they're for; reminders today; travel today (each leg's name and
  time, never a reference or seat) and the trip under way; today's weather
  if a Life log run stored it; and the last place seen. It never holds
  money, note, email or message bodies, or event notes, and `scrub()` takes
  anything shaped like a key, token, email address, link or card number out
  of titles. It's built at most once a minute, kept in the Function's memory
  only, and goes through Jev's check. The prompt marks it as data.
- **Memory across chats.** A new chat's first turn, and a later message
  that brings a new topic or names someone new, gets up to three short
  summaries of past chats on the same topic or about the same people (the
  owner's questions and Athena's last reply, clipped, with no sources). They're read from
  `ask_threads` and opened in the Function, go through Jev's check, are
  marked as data and are never stored anywhere new.
- **What Athena knows** (`GET /api/profile/knows`, full access only like
  the rest of `/api/profile`) lists the owner's `me` facts, details about
  people they told Ask to remember, and `me` suggestions waiting in Review.
  Forgetting archives (a profile answer through `PUT /api/profile`, a
  detail through `/api/facts/:id`) or rejects a suggestion. Nothing is
  deleted for good from here.

### Drafts: email, texts, WhatsApp and Slack

Athena can write a message for you (`lib/drafts.ts`, `draft_message`): an
email, a text, a WhatsApp, a Telegram or a Slack DM, on the apps you've
switched on under Settings → Drafts (Email and Text to begin with). You start one from a to-do (Draft a
reply, Draft a message), a person's page (Draft a message), Home, or Ask.
**It never sends one.** You press Send yourself, in your own app.

- **The ways out, all yours:**
  - **Email:** save it to Gmail or Outlook Drafts for an account you've
    turned drafts on for, or open it ready-filled in your mail app (a
    `mailto:` link). Saving is always your tap on Save in the draft sheet,
    from Ask too.
  - **Text:** open Messages with it filled in (`sms:<number>?&body=…`).
  - **WhatsApp:** open WhatsApp with it filled in
    (`https://wa.me/<number>?text=…`).
  - **Telegram:** open Telegram's share picker with it filled in
    (`https://t.me/share/url?url=…`); you pick the chat. Signal isn't
    offered: its links can't carry text.
  - **Slack:** copy it, then open the DM (`slack://user?team=…&id=…`, or
    Slack's own `app_redirect` without the workspace). Slack's links can't
    carry text, so nothing goes to Slack but the link.
  - **Copy**, everywhere.
  These links are built on the device when you tap (`lib/draft-links.ts`),
  from what's on screen. Nothing goes from Athena's server to Messages,
  WhatsApp, Telegram or Slack. Slack stays read-only: there's no Slack
  write tool, and `slack_send_message` is refused by name.
- **Draft access is per account and off by default.** Gmail and Outlook
  are connected read-only (`gmail.readonly`, `Mail.Read`). "Let Athena save
  drafts" on an account adds one permission and asks you to sign in again:
  - **Gmail:** `gmail.compose`. Google has no drafts-only permission, so it
    also covers sending, and Google's consent screen will say so.
  - **Outlook:** `Mail.ReadWrite`. Microsoft has no drafts-only permission
    either, so it also covers moving and deleting mail (not sending, which
    is `Mail.Send` and never asked for).
- **Athena's side, whatever the permission allows:**
  - drafting only ever calls `create_draft` (`netlify/lib/connectors/gmail-drafts.ts`),
    and only for an account with drafts on (`canDraft`); the tool isn't
    even listed for any other account;
  - for Gmail reached directly, that's the one request that isn't a GET (a
    POST to `users/me/drafts`);
  - for Outlook, `microsoft-graph.ts` sends that POST only when
    `isDraftCreate` passes: `POST /me/messages` with exactly a subject, a
    plain-text body and who it's to, or `POST /me/messages/{id}/createReply`
    with exactly the words and who it's to. Both only make drafts. Any
    other path (`send`, `sendMail`, `reply`, `replyAll`, `forward`,
    `createForward`, `move`, another mailbox) and any extra field (cc, bcc,
    attachments, HTML, `isDraft`) is refused before it leaves Athena. It's
    never retried after a dropped connection, so it can't be saved twice;
  - `callTool` refuses any tool whose name is a send, reply or forward
    (`send_message`, `send_draft`, `reply`, `forward`, `slack_send_message`, …),
    for every account, before the request leaves Athena;
  - collections still can't call write tools at all (`listAllowedTools`);
  - turning drafts off stops Athena using it at once; sign in again (or
    remove Athena in your Google or Microsoft account) to drop the
    permission there.
- **Which channel:** the one you ask for, or the one you use most with them
  in your last 20 catch-ups (Slack, WhatsApp and Telegram by the collection
  that logged them), among the apps you've switched on that Athena can
  reach them on (email, phone, Slack identity). When their usual app is
  off, the next one. The setting is one row in `settings`
  (`draft_channels`, a list of app names). This reads only Athena's own
  records.
- **Finding someone on Slack:** when Slack is one of your apps and Athena
  has no Slack member ID for the person, it asks your connected Slack
  account's `slack_search_users` (read-only, and only if you've allowed
  that tool): with their email, then with their name. What goes to Slack
  is that search: the email address or the name. It takes the one user
  whose email matches, or failing that the one whose real name matches
  exactly (display names and handles don't count). Two or more possible
  matches: nothing is saved and nothing is guessed. A match is saved on the
  person as a Slack identity (encrypted like the others, §11), so it's
  there next time and you can remove it. Nothing about the search goes to
  Claude.
- **What Claude sees to write it:** the to-do, the person's name and
  relationship (their email only for an email), the details you've saved
  about them, your last three catch-ups, the note collected from the same
  email or meeting, and (when the to-do came from an email, it's an email,
  and get_thread is allowed for that account) the last few messages of that
  thread. The thread goes through Jev's injection check first; if it's
  flagged, the draft says "Read this one carefully".
- **Your voice:** for a new draft, up to three of your own sent emails (to
  that person when there are some, otherwise your latest), from a Gmail or
  Outlook account where you've allowed search_threads and get_thread. Only
  messages you sent are used, up to 600 characters each, and Claude is told
  to match how you write, not to copy what you said. It's skipped after 8
  seconds, or when no account allows it, and the channel's default style
  is used instead.
- **Your Slack voice:** for a new Slack draft only, Athena searches your
  connected Slack account for `from:me` with `slack_search_public_and_private`
  (or `slack_search_public`), read-only and only if you've allowed the
  tool. From what comes back it keeps the text of up to five of your
  messages: no channel names, no people, no links to them, up to 300
  characters each. Those five go to Claude inside `<owner_voice>`, only to
  set the style (length, greeting, tone), and Claude is told not to copy
  them. They go through Jev's injection check first and are dropped if
  flagged. When there are some, your sent email isn't read for that draft.
  Nothing is stored; it's skipped after 6 seconds.
- **Nothing is stored** by drafting itself: not the draft, the thread, your
  sent mail or your Slack messages. The one thing it can save is a Slack
  member ID on a person, as above. A draft exists in the sheet, in your Drafts once you save
  it there, or in the app you open it in.

### Ask's answers

A question in Ask ("What did Gayle say about pricing last month?") gets a
written answer from `lib/answer.ts`, the same loop that makes changes ("One
loop: who can ask for a change", above). A message that only asks changes
nothing, and the loop never writes to a connected account. One thing
follows an answer in Athena: an item it cited from a connected account is
saved (below).

- **What Claude sees, to answer one question:**
  - the question, and the last twelve questions and answers in the same
    conversation, each answer with the refs and links it cited (up to
    eight; a list of what to read again, never a source by itself);
  - files you added to the conversation (the question's own, then the latest
    others, five at most). The question's own go in whole: photos and PDFs
    as they are, text up to 100,000 characters. Earlier ones go as their
    saved summary, and `read_file` fetches one of them whole when the
    question needs it. Their text, and the summary Claude wrote of it, is
    someone's data, never instructions;
  - from Athena: search results (titles and short snippets of matching
    notes, to-dos, catch-ups, details about people, people and watch &
    read), any note it opens in full (up to 6,000 characters), and for a
    person it looks up, their details, recent catch-ups, open to-dos both
    ways, decisions and the titles of notes that mention them;
  - for a question about taste (`taste`, `lib/taste.ts`): titles of finished
    and rated films, shows and books with their stars, the shows and films
    watched most, the YouTube channels liked most and playlist names, and
    the artists played most, with counts. Read-only, from Days and Watch &
    read, including history loaded on connect;
  - whatever the shared read tools return when it calls them, today's
    context, and for a new chat, or a later message that brings a new
    topic or person, short summaries of related past chats
    ("Ask's read tools, today's context and memory", above);
  - from each connected account: whatever the account's **allowed** read
    tools return for the searches it runs, e.g. Granola meeting notes and
    transcript passages, Gmail threads, calendar events, Slack messages,
    and the Life log's lists (what was watched, played, read or posted). An
    NSFW Reddit item reaches Claude as its community, date and a link with
    the title slug removed, never its title or text.
    Each result is capped at 8,000 characters.
- **Same allowlist as collections (§9).** Only tools the owner allowed for an
  account, re-checked as reads when listed, and a call to anything else is
  refused before it leaves Athena. On the Netlify Server an account opened
  for one answer is kept open for the next ones
  (`netlify/server/assistant/warm-sources.ts`), with its tool listing: it's
  opened and listed afresh when its row changes (a sign-in, a token, the
  allowlist, a switch) and at least every 10 minutes, so a custom server's
  changed tool is caught within that time rather than on the next answer. `callTool` refuses send, reply and forward
  tools for every account. For the services Athena knows, only search and
  read tools are offered at all.
- **Untrusted content.** Everything the tools return is someone else's words.
  The system prompt says it's data, never instructions. Results from
  connected accounts, the note bodies and search snippets go through Jev's
  `guardText` first, and anything that looks like it's instructing an AI
  reaches Claude behind a warning; the answer then says something it read
  was treated as plain text. The write tools are on offer in the same
  loop, so what a successful injection can do is bounded by the guard
  ("One loop: who can ask for a change"): a wrong answer, a cited link the
  owner didn't expect, that item saved to Athena (next point), a plan the
  owner would have to approve, and, while web search is on, words Claude has
  read going into a web search (below). Links in an
  answer are drawn as plain links and never fetched.
- **Web search** ("Let Ask search the web", Settings → Ask, on by default;
  stored server-side as `ask_web`, `GET/PUT /api/profile/ask-web`; owner,
  12 Nov 2026). While it's on, Claude may search the web up to three times
  an answer through Anthropic's server web search tool, for what the
  owner's data can't answer. The search runs on Anthropic's side: the
  search words go to Anthropic and its search provider, and nothing else
  of the question does beyond what Claude already sees.
  - *What may go in a search.* The prompt allows the public subject of the
    question and nothing read from Athena, the accounts, the profile,
    today's context, files or earlier chats: no company's name from the
    owner's life, no address, number, amount or booking.
  - *People's names* (owner, 12 Nov 2026). A person's name the owner typed
    in any of their own messages in the same conversation, the question
    being asked or an earlier one, may go in a search, as typed: "Who is
    Priya Shah at Acme?" may search for her, and so may a later "What
    does she do now?". An @-mention counts as typed. Nothing Ask read
    about that person goes with it. A name Ask only read in Athena, the
    accounts, the profile, files or its own earlier replies, and the
    owner didn't type, never goes in a search.
  - *What backs the prompt up.* Every search is shown to the owner as a
    step with its words. The tool is taken away for the rest of an answer
    once anything read is flagged by `guardText`, before Claude sees that
    text, and once a search holds an email address (typed or not) or the
    full name of a person Athena's tools returned in that answer, unless
    the owner typed that name in the question or in an earlier message of
    theirs in the conversation. An injection that gets past the
    flag could still put words Claude has read into a search; it can't
    choose where they go, and at most three searches are made.
  - *Off.* The tool isn't sent to Claude at all. A read of the switch that
    fails counts as off.
  - *Web pages* are someone else's words like any tool result: data, never
    instructions. A page is cited by its link only if the search returned
    it in that answer (kind `web`), drawn as a plain link, and never saved
    to Athena or sent to `/api/assistant/import`.
- **General answers.** When the owner's data doesn't hold the answer,
  Claude may answer from what it knows; the reply is marked `general` and
  the app labels it. Nothing more is read or sent for one. A claim about
  the owner's own life still needs a source from that answer's tools.
- **Cited items are saved** (`netlify/lib/connectors/ask-import.ts`; owner,
  8 Nov 2026). When an answer rests on an item in a connected account that
  Athena doesn't have, the app posts it to `/api/assistant/import` once
  the answer is on screen, with no extra tap, and it is saved the way that
  account's collection would save it: at most five per answer, each
  through the collection pipeline for one item, with Undo (archive) under
  the answer. An item Athena already has is skipped.
- **No made-up links.** Every source in an answer is checked against what
  the tools returned during that answer; a note, person, to-do or link that
  didn't come back from a tool is dropped before the app sees it.
- **Finance and health stay sealed at rest (§1).** They're opened in the
  Function only by the shared read tools below, when the model calls one,
  and go to Claude for that answer only. As with
  collections, a Custom account pointed at financial records would be readable
  through its allowed tools, so don't connect one.
- **Nothing is stored.** Questions, answers and what the tools returned aren't
  saved or logged; logs name an account that failed and that a source was
  dropped, never content.
- **Limits.** `POST /api/assistant` needs the bearer token and is
  rate-limited (20 a minute). A turn that only looks things up makes at
  most 6 model calls and 14 lookups, each lookup with a 9-second timeout,
  and stops at 45 seconds (10, 24 and 120 seconds on the Netlify Server).
  Once it calls a write tool it may make up to 14 model calls in four
  minutes (15 on the server), as an instruction always could.

### Links a turn may open (`lib/run-links.ts`, migrations `0085` and `0088`)

A web-enabled assistant's turn gets Anthropic's server web fetch tool
(`webFetchTool` in `lib/answer.ts`). It may open any link in the turn's own
message, a page `web_search` returned, or a link `find_saved` gave. The
fetch runs on Anthropic's side inside the model call, so Athena's leak check
on a page's link (`ev.leaks`) only sees the request after it has gone. So
a link goes into a run's message as one it may open only if the owner
supplied or approved it.

- **A saved item's own link** is the owner's: it's what they saved. A run
  about the item gets it, and a tracker on the item opens it.
- **A tracker's link** carries who set it (`trackers.url_set_by`, 0085):
  `owner` (typed in the app, or approved by the owner on a plan), `item` (the
  saved item's own) or `ask` / `assistant` (a model chose it and the owner
  hasn't approved it). A run's message gives a tracker's link only when it's
  the owner's or the item's (`runUrlOf`, `trackerLines` in
  `lib/team-chat.ts`); a saved item's tracker otherwise gives the item's own
  link, and one on its own gives none, so the run searches for it by name.
  Trackers made before 0085 had no record of who set their link. The owner
  chose (24 Nov 2026), once, to approve every one of those links:
  migration 0088 marks each as set by the owner, so those trackers keep
  working. It touched only rows with no record; a link a model chose since
  0085 still waits for approval.
- **`track` with a link a model chose waits for the owner's approval** (above),
  for every assistant and for main Ask. Athena writes the approval card's line and
  ignores the model's own step text: what's tracked, the link's host and the
  whole link (`stepLabel` in `lib/ask-plans.ts`). The link loses its
  fragment, which a browser never sends to the server. Its query is kept: a
  shop's link often needs it to name the right product, and the owner sees
  it on the card. Approve runs the step
  under `asOwnersGo`, so the link is kept as the owner's; anywhere else a
  model's link is kept as the model's and never opened by a run.
- **A model's words in a run's message can't open anything.** Every web
  address in them is written with `[.]` and `[://]` (`unlinked`): a reader
  still sees where it points, but the message holds no link to it. This
  covers a tracker's name and its checks' shops or sites; a flow's values
  from earlier steps, in a think step's message and task (`thinkPrompt`,
  `lib/flow-run.ts`); an
  assignment's work, handoffs, suggested answers and send-back notes
  (`stageMessage`, `lib/assignment-run.ts`), where `hand_off` puts the
  work's links back as they were before the note is written. A send-back
  note keeps who wrote it (`note_by` in the stage's sealed words): the
  owner's goes in as written, so its links can be opened; a stage's, or
  one kept before this was recorded, can't; and the shop
  in `find_saved`'s best price now. The owner's own words (an assignment's
  brief, an owner's answer, a flow's task text) go in as written.
- **Tested** (`lib/run-links.test.ts`, `lib/trackers.db.test.ts`): `track`
  with a model's link on an assistant's allowlist doesn't run alone in a
  run, and comes back as a plan whose line shows the whole link and its
  host; Approve makes it the owner's, and a run may then open it; main Ask holds
  it too when the owner asked to track something; a tracker an assistant
  started with its own link appears in a run's message with no link until
  the owner sets it; a model's addresses in tracker lines, flow values and
  assignment stages are written so they can't be opened.

### Choosing models from other providers (`lib/models.ts`, migration `0076`)

Owner, 17 Nov 2026: ask once per provider, then anything goes.

- **One agreement per provider.** Before any choice on OpenAI, Google, Meta or
  OpenRouter, the owner agrees once (`POST /api/models/consent`, kept with
  the time in the `settings` row `ai_models`). Once agreed, that model reads
  whatever its role reads, money and health included. Anthropic needs none.
- **Enforced on the server.** `PATCH /api/models`, an assistant's `models`
  on `POST`/`PATCH /api/team`, and `POST /api/models/test` refuse a provider
  with no agreement (409 `consent_needed`). A choice on such a provider that
  is already in the row (written by hand, or left from before) is ignored
  when read, so no request goes there.
- **Taking it back** (`DELETE /api/models/consent/:provider`) removes the
  agreement and every choice on that provider: the owner's, each job's and
  each assistant's go back to the default in the same request.
- **Able to do the job.** A model Athena knows can't use tools is refused
  for thinking; only a picture model is accepted for pictures, and a picture
  model isn't accepted for anything else. A model the gateway doesn't list
  is refused.
- **Plain, not sealed.** Model names and agreement times aren't sensitive:
  `ai_models`, `team_assistants.models` and `team_runs.model` are readable
  (excused in `lib/encryption-coverage.test.ts`). The gateway's list is read
  from `api.netlify.com` with no key and nothing of the owner's.

### The owner's own provider keys (`lib/ai.ts`, `lib/llm/shared.ts`)

By default every model call goes through Netlify AI Gateway, with the key
and address Netlify injects into the functions. The owner can set a
provider's own key instead (GUIDE "Your own keys"): `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY` or `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `META_API_KEY`,
`OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`. Netlify never overrides a key or
address the site sets, so that provider skips the gateway.

- **What leaves the site is the same.** The same prompts, tool results and
  recordings go to the same provider, under the same consent rules (above).
  Only the path changes: from the functions straight to the provider's own
  address (or the `*_BASE_URL` the owner set), not through Netlify. The
  provider's terms with the owner cover it.
- **Where the key lives.** A Netlify environment variable, set as a secret
  and scoped to functions, like the data key. It's read on each call and
  never logged, stored in the database or returned by the API. When a call is
  refused, the log shows only the credential's 8-hex fingerprint (`lib/ai.ts`
  `fingerprint`).
- **An address the owner sets is trusted.** A `*_BASE_URL` receives the key
  and everything sent to that provider. Athena doesn't check it, so set one
  only for a proxy or endpoint you run or trust.
- **Without the gateway or a key**, that provider is unavailable and nothing
  is sent to it. Without TypeSafe, Jev's check for collected text that tries
  to instruct an AI (`guardText`) doesn't run, so nothing is flagged that
  way. The rest of Ask's guard (`lib/ask-guard.ts`: no change after other
  people's words unless the owner plainly asked) and the read-only tools
  still apply.

## 11. Encryption at rest: everything you write

Athena's content is encrypted in the database with a key that only the
production Functions hold, the same model §9 uses for sign-ins. The
Functions decrypt as they read, so the 07:30 briefing, meeting pushes,
collections, Claude over MCP and the app all work as before; the app gets
plaintext over authenticated HTTPS and changes nothing.

**What it protects against.** Anything that can read the database but not
the production environment: a dump, a backup, the Netlify DB console, and
deploy previews' database branches, which are copies of production data.
Previews don't have the key, so they hold ciphertext and show placeholders.

**What it doesn't.** This is not end-to-end encryption. The server holds the
key, so anyone who can read the production environment variables *and* the
database (a Netlify account with access to the site, or the platform itself)
can decrypt. That includes finance and health rows, which are sealed under
the same key (§1–2).

### What's encrypted

Every value below is sealed one at a time (`lib/data-box.ts`).
`lib/encryption.ts` holds the same list as code (`ENCRYPTED`); the backfill,
the status counts and the tests all read it from there.

| Table | Encrypted columns |
|---|---|
| `notes` | `title`, `body`, `tags` (each tag) |
| `note_versions` (earlier versions of a note, migration `0061`) | `title`, `body`. Who made the change (`changed_by`) and when stay readable |
| `note_chunks` | `content` (a copy of note text; not used yet) |
| `people` | `name`, `notes`, `relationship`, `email`, `phone` |
| `identities` | `value` (extra emails, phones, Slack handles, aliases) |
| `events` | `title`, `notes` |
| `reminders` | `text` |
| `places` | `address`, `url`, `notes` |
| `organisations` | `website`, `notes` |
| `projects` | `description` |
| `commitments` (to-dos) | `title`, `notes` (the description), `source_quote`, and from `0084` `steps` (the checklist) and `links` (web addresses and athena:// links, with their titles), each list one sealed JSON value. `priority` (0 to 3) stays readable |
| `interactions` (catch-ups) | `summary` |
| `facts` | `value`, `source_quote` |
| `suggestions` (Inbox) | `summary`, `payload`, `source_quote`, and from `0086` `email` (the sender, subject and account id of the email a find came from, one sealed JSON value) |
| `assets` (life admin) | `name`, `provider`, `notes` |
| `reading_items` | `title`, `url`, `author`, `notes`, `sync` (match keys and what a source last wrote, migration `0029`), `meta` (year, running time, genres, playlists, your tags and the seasons it suits, migration `0063`) |
| `goals` | `title`, `target`, `notes` |
| `saved_items` (Saved, migration `0038`) | `url`, `title`, `site`, `author`, `excerpt`, `readable` (the page's text), `quote`, `note`, `source_url`, `tags` (each), and from `0039` `facts` (what's known about it: author, ISBN, price, address, as JSON) and `filed_to` (where an action filed it, and its undo). The link has a blind index (`url_bidx`) so the same page saved twice is one item. Kind, source, dates, image size and tone, `thing` (book, film, product, place…) and `filed_at` stay readable. Images: see "Saved" below |
| `link_previews` (rich links, migration `0040`) | `title`, `summary`, `site_name`, `author`, `kind` and `facts` (JSON). The address isn't stored: the row is found by a blind index of the normalised address (`url_bidx`) that each request brings. `status`, `fetched_at`, `checked_at` and the picture's size and tone stay readable. Picture and favicon: see "Link previews and embeds" below |
| `habits` (the owner's own, migration `0036`) | `name`, `unit`. Ticks are `habit` day entries (source `athena`), sealed like any entry; the schedule, target and icon stay readable |
| `collected_items` | `title` (the title of the note or event a collection wrote) |
| `collection_runs` | `summary` (the collector's run summary names what it saved) |
| `connectors` | `mail_rules` (Gmail and Outlook: which emails Athena reads, one sealed JSON value, migration `0043`; senders can be people's addresses) and `write_parent_title` (the Notion page new pages go under). `mail_skips` holds only per-account daily counts |
| `trips` | `title` (where it's to), `notes` |
| `trip_bookings` | `title`, `provider`, `reference`, `segment`, each end's zone, place and city, `seat`, `details`, `email_link`, `cancel_email_link` |
| `purchases` | `retailer`, `items` (each item), `order_number`, `carrier`, `tracking_number`, `tracking_url`, `email_link` |
| `purchase_updates` | `detail`, `email_link` |
| `custom_fields` | `label`, `unit`, `options` (one sealed JSON string) |
| `custom_values` | `value` (the value as sealed JSON text) |
| `custom_kinds` (the owner's own types, migration `0018`) | `name`, `one` (what one record is called) |
| `custom_records` (the records in them) | `title`, `body` |
| `ask_threads` (Ask's conversations) | `title`, `messages` (the whole conversation as one sealed JSON string) |
| `files` (migration `0019`) | `name`, `summary`, `extracted_text`; the bytes themselves are sealed in Netlify Blobs (see "Files" below) |
| `days` (migration `0032`) | `line`, `private` (mood and journal) |
| `day_entries` | `external_id`, `title`, `subtitle`, `url`, `grp`, `note`; the source's id is matched by a blind index (`ext_key`) |
| `note_templates` | `name`, `body`, `summary` |
| `document_exports` | `title` |
| `recipes` (migration `0053`) | `url`, `title`, `body`, `tags` (each); the address is matched by a blind index (`url_bidx`) |
| `grocery_items` | `item` |
| `sensitive_blobs` (§1) | `ciphertext`, for every row with a day: health, location, money, home and finance |
| `place_geo` | `sealed` (a Place's coordinates, ids, town and visit days) |
| `nudges` (migration `0051`) | `payload` |
| `ask_skills` (migration `0058`) | `payload` |
| `ask_plans`, `ask_activity` (migration `0055`, §10) | `payload` |
| `ask_routines` | `payload`, `pending` (a routine's waiting nudge) |
| `flows` (migration `0080`, §10) | `payload` (a flow's name, its whole trigger with any words it matches, and its steps). `trigger_kind` and `schedule` (days, times, counts and the facets an event filter names, never its words) stay readable |
| `flow_runs` | `label`, `summary`, `error`, `state` (each step's line, the values steps gave, what it waits on, the cards it owes). Statuses, times and ids (the Ask plan or assignment it waits on, the records it made, the run that started it and the flows before it) stay readable |
| `note_link_choices` (migration `0059`) | `payload` |
| `settings` | values inside rows: the car record (`car`, §16), the notification key's private half (`vapid`, §8), the owner's playlists (`music_playlists`), artists' genres (`music_genres`) and what the home's appliances were last seen doing (`appliances`) |

Every sealed store is on one of three lists in `lib/encryption.ts`:
`ENCRYPTED` (columns), `SEALED_BYTES` (file bytes, saved images and art in
Netlify Blobs) and `SEALED_SETTINGS` (values inside `settings` rows). The
status counts all three and the backfill re-seals all three. A new sealed
column, settings value or blob store has to be added to one of them:
`lib/encryption-coverage.test.ts` fails if code seals a table that isn't
listed.

Two caches are sealed with the same key and deliberately not moved:
`link_previews` and `location_cache` are keyed by a blind index, so after a
rotation the backfill drops the rows under another key and they are read
again when next shown.

Booking references, order numbers and tracking numbers are matched by blind
index too (`trip_bookings.reference_bidx`, `purchases.order_bidx`,
`tracking_bidx`, migration `0015`), so a later email finds its booking or
order without the number being readable. A trip's dates, a booking's
instants, kinds and statuses stay readable: lists, Coming up and the
booking pushes sort and filter by them. A booking's places and time zones
are encrypted, since together they say where you're going. Purchases have
no price, total or card column at all, and the collector refuses text
that carries an amount. A receipt's fare or total and Amazon order amounts
are kept only as sealed `sensitive_blobs` rows, domain `finance` (§1).

People's names are encrypted too. Exact lookups on people still run in SQL
through **blind indexes**: `people.name_bidx`, `email_bidx`, `phone_bidx` and
`identities.value_bidx` (migration `0012`) hold HMAC-SHA256 of the
normalised value (name lowercased with spaces tidied, email lowercased, a
phone's last ten digits) under an index key derived from the data key. That's
how `resolve_person`, the collector's "find or create this attendee" and
"already belongs to someone else" work without decrypting everyone. Partial
names, sorting by name and `@`-mention search decrypt the candidates in the
Function instead.

### What stays readable, and why

- **Ids, dates and times, kinds, statuses, counts, flags** (`archived_at`,
  `due_on`, `remind_at`, `keep_in_touch`, …): every list, reminder and the
  briefing filter and order by these in SQL. They show *that* something
  exists and when, never what it says.
- **The `edges` link graph**: who or what links to what, by id. It reveals
  the shape of your notes (this note mentions that person), not their
  content.
- **`source` and `source_ref`**: which collection wrote a row, and where it
  came from (a URL or `note:<uuid>`). Used to filter and to stop duplicates.
- **Fact keys** (`Kids`, `Coffee order`): labels, not values; facts are
  grouped and replaced by key in SQL. The values are encrypted.
- **Names of places, organisations and projects** (`Dishoom`, `Netlify`):
  collectors match them by name every run, and lists sort by them.
- **A type's icon and position, and which type a record is in**
  (`custom_kinds.icon`, `position`; `custom_records.kind_id`): the icon is a
  name from a fixed list (`wine`, `leaf`, `folder`…), checked by the
  database, and the Library and Settings order by position. A type's name
  is encrypted, so its uniqueness is checked in the Function, and a name
  that sounds like finance or health (`sensitiveLabel`, §1) is refused, so
  that content never goes in a type.
- **To-do contexts** (`todo_contexts`, migration `0037`): each area's and
  where/how's name, icon and colour, which ones a to-do carries
  (`commitments.area_id`, `where_id`, `context_by_athena`), and
  `todo_context_hints` (the owner's last correction per `person:<id>` or
  `source:<source>`). Labels like "Work" or "Phone", as low-sensitivity as
  fact keys; the to-do's title, notes, quote, steps and links stay sealed.
- **To-do priority** (`commitments.priority`, migration `0084`): a number from
  0 (none) to 3 (high). It says how urgent something is, not what it is.
- **A to-do's links to things in Athena** become `edges` rows from the
  to-do (origin `content`), like a note's mentions: ids only, so the graph
  and backlinks can show them. Web addresses stay inside the sealed `links`.
- **`metrics`**: names, values and metadata, as written. The owner chose
  (9 Nov 2026) to leave them readable. Nothing in code keeps a health or
  money figure out of them; a prompt rule is the only guard (§1).
- **Settings, connector and collection settings, push subscriptions,
  `reminder_log` keys**: configuration and counts. A connector's `url` can
  hold a profile handle, and a collection's instructions are the owner's
  own words. A push subscription's `credential` is a fingerprint, not a
  token (§8). A `reminder_log` key is made of ids and dates; a payment
  nudge's holds a blind index of the merchant (§1).
- **Ids from other services**: `collected_items.external_id` and
  `source_ref` (often a message link), calendar ids on events, connectors
  and `calendar_creates` (a Google calendar id is an email address), and
  `document_exports.url` (a Notion address usually contains the page's
  title).
- **Error text from other services**: `connectors.status_detail` (up to
  300 characters of a provider's error), `events.rsvp_error` and
  `collection_runs.error`. A database error there holds a code and a
  constraint name only ("Known limits", below).
- **Words used as labels**: an edge's `relation` ("sister"), a habit
  nudge's key, which includes the habit's name, and `places.name`, which
  after a Timeline or Swarm import is a list of venues visited.
- **Dismissed flow suggestions** (`flow_suggestion_dismissals`, migration
  `0082`): one id per suggestion the owner turned down, and when. An id
  names the kind of habit ("follow-delivery-reminder",
  "saved-book-watch_read"); one built on the owner's own words (a reminder
  or to-do they set every week) carries the first 12 hex characters of a
  SHA-256 of those words, lower-cased and without numbers or punctuation,
  never the words. A short phrase can be confirmed by guessing it, so the id
  says no more than "they dismissed a suggestion about putting the bins
  out" to someone who already guessed that. Suggestions themselves are
  worked out on each `GET /api/flows/suggestions` from tables already
  described here (`lib/flow-suggest-store.ts`), are not stored, use no
  model and send nothing off the site.
- **What any encryption shows**: roughly how long each value is, which
  fields are empty (empty stays empty), and, from blind indexes, which people
  share a name or email.
- **Dismissed person suggestions** (`settings.todo_person_dismissed`): the
  ids of to-dos whose "Link to" suggestion the owner dismissed. Ids only.
  The suggestion itself is never stored: names, nicknames and titles are
  opened in the Function, compared in memory and dropped.

### Saved (migration `0038`, `lib/saved.ts`)

- **Who can send.** `POST /api/saved` and `GET /api/saved/ping` take a capture key (the same scope as Siri capture); everything that reads back (list, item, image, edit, delete) needs the master token or a full key. CORS answers any origin, which is how the browser extension (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) reaches it; the key, not the origin, is the check.
- **Reading the page.** A link's page is fetched once, at save time or on "Read again", through `publicFetch` (`lib/saved-fetch.ts`): https only (an http link is read over https), every redirect hop checked against internal addresses before and while connecting, 8 seconds for the whole read, 3 MB of HTML, HTML only. Its lead image goes the same way (6 MB, sniffed as JPEG, PNG, WebP or GIF). The row is saved first, from the address alone, and updated after the read, so a read that throws or is cut off still leaves the saved link, and "Read again" retries it. Metadata (JSON-LD, meta tags) is read from the first 300,000 characters only. A page nested deeper than 300 levels isn't parsed at all and reads as "failed"; one with more than 20,000 elements keeps its title, picture and summary but no readable copy. The User-Agent names Athena and nothing about the owner. Nothing else on the page is fetched or run: Readability runs over linkedom's DOM (no scripts), and the text is kept as plain paragraphs, never HTML, so the app draws it with `textContent`.
- **Images.** The owner's own (10 MB cap, type from the bytes) and a page's lead image are re-encoded by sharp to WebP at two sizes, which drops EXIF and location, then sealed under the data key in the `athena-saved` blob store. The header is read first (`decodeImage` in `lib/art.ts`): anything over 25 megapixels is refused, or 60 for a JPEG, judged by the bytes and not by what the file claims, and the image is decoded once. Link preview pictures and artwork go through the same function. Without the key an image is refused (503), never stored readable. `GET /api/saved/:id/image` sends them with `nosniff`, `no-store`-style private caching and a sandboxing CSP. Rotation re-seals them (`resealSavedImages`).
- **Caps.** 20,000 characters each for text, selection and note; 300 for a title; 200,000 for the readable copy; 12 MB a request. The platform's own request limit is lower than the 10 MB and 12 MB caps, so in practice it is the one that applies.
- **Actions** (migration `0039`, `lib/saved-actions.ts`). What a page is comes from the HTML already fetched for the readable copy, parsed as data (JSON-LD and meta tags, no scripts), or from its address alone; nothing more is fetched. Listing and running actions (`/api/saved/:id/actions…`) needs the master token or a full key, like every other read; a capture key gets 401. MCP has `list_saved_actions` and `run_saved_action` (no undo, no delete). Actions run through Ask's own tools, so they only add: a line on a list, a watch & read item, a place, a to-do, a graph link. Undo takes back exactly that: the line it added, what it made (archived, never deleted), or the link. An undo sent by the app is checked against those three shapes, so it can't be used to archive anything else.
- **Share target.** The installed app's share target posts to `/share-target`, which the service worker answers itself (`shareFrom` in `app/public/sw.js`). A POST from another website is refused: nothing is kept. A share the worker can place as the device's own (`Sec-Fetch-Site` of `none` or `same-origin`, or failing that an `Origin` that is the app's own) is kept in Cache Storage (`athena-share`: the title, text, link and first image) and marked trusted; the app sends it with its key and deletes it. A share with neither header is kept unmarked, and the app shows it with Save and Don't save and sends it only on a tap. Only the worker writes the mark; a form field named `trusted` is ignored. The owner can turn on "Always save what I share from this device" (on the Save prompt, or Settings → About you): after that an unmarked share on that device saves at once. The switch is kept in `localStorage` on the device, so Sign out removes it, and the worker never reads it: another site's POST is refused first, whatever it says. `#/saved/shared?demo` works in sample mode only. Nothing goes to the server until the app sends it. Checked in Chromium only; what a real Android or iOS share sends wasn't measured.

### Link previews and embeds (migration `0040`, `lib/link-previews.ts`, `lib/embeds.ts`)

- **Who can ask.** `GET /api/link-preview`, its pictures, `GET /api/places/:id/map` and `GET /api/link-map` need the master token or a full key. A capture key gets 401.
- **Reading the page.** Only through Saved's page reader (`lib/saved-fetch.ts`), with the same guards: https, every redirect hop checked against internal addresses, 8 seconds, 3 MB of HTML, HTML only. The picture (6 MB) and the favicon (512 KB) go the same way and must sniff as JPEG, PNG, WebP or GIF; an SVG or ICO favicon is never fetched. Nothing on the page is run; the extractor and kinds read it as data.
- **How often.** Page reads are limited to 30 a minute per caller (Saved's per-minute table, its own bucket); kept previews don't count. A good read is kept 30 days, a failed one an hour, so Athena doesn't ask a site for the same address over and over.
- **What's kept.** Sealed text in `link_previews` (§11 table), and nothing at all without the data key (503). The address isn't stored, so the table can't be read as a list of pages the owner linked to. Picture (1200px) and favicon (64px) are re-encoded by sharp to WebP, which drops EXIF and location, then sealed in the `athena-link-previews` blob store. Rows aren't in the encryption backfill: Athena writes them only with the key, and finds a row sealed under an old key by that key's index, then replaces it on its next read.
- **Serving pictures.** `GET /api/link-preview/:id/image` and `/favicon` send WebP with `nosniff` and `default-src 'none'; sandbox`, as Saved's images do. The address carries `?v=` (when it was read), so a refresh gets a new address.
- **Links Athena wrote are never previewed.** A card, mention or embed makes the server fetch the address, so only links the owner typed or chose get one. The server drops the mode from every web link in model text (`plainWebLinks` in `lib/links.ts`: Ask's replies, answers and the briefing), and the app draws every web link in Ask as a plain link. In a note the owner didn't write (any `source` but `manual` or `app`), each web link present when the note opens is drawn plain and asks for nothing; the Markdown isn't rewritten. A link the owner pastes there, or switches to Card, Mention or Embed, loads as usual. When a model edits a note the owner did write (`save_note` with a note id), the text it writes has every web link's mode dropped before it's saved (`plainNewWebLinks`), except a link whose address already had that same mode in the note: the owner's own choice stays, and nothing the model adds is fetched for a preview.
- **A remembered choice** (`note_link_choices`, migration `0059`, `lib/note-link-choices.ts`). When the owner picks Card, Mention or Embed for a link in a note Athena wrote, the app stores `{ url, mode }` and that link loads again next time; picking Link takes it back. The choice isn't in the note: nothing in a note's title, body, tags or a link's title is read as one. The table is written only by `PUT /api/notes/:id/link-choices` (master token or full key; a capture key gets 401), and no assistant, collection or MCP tool writes it, so model-written text can't set one. The list is one sealed value per note. A choice frees one address in one mode; a changed address or mode is held again. Offline and in sample mode no choice is saved or loaded.
- **Embeds.** `lib/embeds.ts` reads an address, never HTML: text with `<`, `>`, quotes or spaces is refused, so a pasted `<iframe>` snippet can't put markup into a note. The embed address is built from the ids in the address on the provider's own embed host (YouTube on `youtube-nocookie.com`), and query strings aren't carried over except the few that choose what plays. Hosts match exactly or at a dot. Stage 2 loads players only on a tap, in sandboxed iframes (`allow-scripts allow-same-origin allow-popups allow-presentation`, which players need) with each provider's `allow` list and a CSP `frame-src` of `EMBED_FRAME_HOSTS`. The PDF viewer's frame, which shows the owner's own file, has no sandbox attribute. Google Maps and Apple Maps have no player: the still is Athena's own, and "Open map" hands the spot to the maps app picked for the device in Settings (Apple Maps, Google Maps or OpenStreetMap), so nothing loads from Google or Apple inside a note. Previews not used for 90 days are deleted, with their pictures, by a monthly sweep.
- **Previews through a connected account.** For a Notion address, when a Notion account is connected and allows `notion-fetch`, Athena reads the page through that account (one of the preset's read tools) instead of fetching it, so a private page shows its own title rather than Notion's sign-in page. Only the title and the opening lines are kept, sealed like any preview. With no account, or on any failure, Athena reads the page like any other.
- **Mini maps.** The same rules as day maps (§13): the tile provider gets tile numbers, the style and the owner's key, never the spot, the place's name or the link. A Place's spot is read from its sealed `place_geo` row inside the Function. A Place without one but with a typed address is looked up on OpenStreetMap's Nominatim: Athena sends the address alone (never the place's name or id), at most one lookup a second, once per address. The answer, including "not found", is kept sealed in `location_cache` under a blind index of the address, and isn't written to `place_geo`, so it never changes which visits match the place. A map link's still uses the coordinates in the address the owner pasted. Stills are sealed in `athena-maps`, keyed by a blind index of the spot, provider, style and size.
- **Logs** name the step only: never an address, a title, a place or a coordinate.

### Recipes: reading recipe pages (migration `0053`, `lib/recipes.ts`, `lib/recipe-parse.ts`)

- **Who can ask.** Everything under `/api/recipes` needs the master token or a full key; a capture key gets 401. A share or a Siri link still arrives through Saved's capture route (above), and Saved hands a recipe page on.
- **Reading the page.** A recipe page is fetched once, by Saved's page reader (`lib/saved-fetch.ts`), with its guards: https only, every redirect hop checked against internal addresses, 8 seconds, 3 MB of HTML, HTML only. Recipes reads the recipe out of the HTML Saved already has, so a link costs one fetch. A page is fetched again only for a Saved item that was kept before Recipes, for "Read the page again", and for Try harder. Imports count against Saved's per-minute limit (60 a minute).
- **Parsed as data.** The recipe comes from the page's schema.org Recipe in JSON-LD (`JSON.parse`), else microdata (linkedom's DOM, no scripts). Nothing on the page runs, and every value is turned into plain text before it's kept. The app draws it with `textContent`. The photo is Saved's sealed copy, served by `/api/saved/:id/image`. The app never loads the recipe site's own image address.
- **The model only on request.** Reading a recipe never uses the model unless the owner taps Try harder (`harder: true`). Then the page's readable text, at most 40,000 characters, is passed through Jev's `guardText` and sent to Claude through AI Gateway. The system prompt says the page is data, never instructions. Claude can only answer through one tool (`recipe`), and the answer is checked and read as ingredient lines again. Nothing else from the account goes with it.
- **Ask.** `find_recipes` is a read tool on both back ends and returns the owner's own recipes. `import_recipe` (the assistant only) reads a link the owner sent, through the same path, with an Undo that archives the recipe. Neither can delete anything.
- **What's kept.** A recipe's title, address, body (ingredients, steps, notes) and tags are sealed under the data key (§11). The canonical address is matched by a blind index (`url_bidx`), so the database can't be read as a list of recipe sites. Readable columns: minutes and servings (the grid's filters and the week plan), how it was read, dates. A grocery line's text is sealed; its amount, unit and aisle are readable and name nothing without it. The week plan stores recipe ids and dates. Pantry staples sit in `settings` as plain words (salt, olive oil).
- **The week plan and the calendar.** Suggestions read the owner's calendar events through the same calendar port as scheduling, and trips from Athena. Event titles appear in the reason shown to the owner ("Quick: Book club at 19:00") and are never stored. Suggestions are plain scoring in code, never a model.
- **Logs** name the step only: never an address, a title or an ingredient.

### Files

Photos, screenshots, PDFs and Markdown/text added in Ask or to a note
(`lib/files.ts`, migration `0019`).

- **Sealed bytes, no public URLs.** Each file's bytes are sealed under the
  data key before they're written to Netlify Blobs (`sealBytes` in
  `lib/data-box.ts`: AES-256-GCM, a fresh IV per file, the key id in a
  5-byte header). The blob store only ever holds ciphertext; the name in
  the database is sealed like other text. The only way back is
  `GET /api/files/:id` behind the bearer token, sent with `nosniff`,
  `no-store` and a sandboxing CSP.
- **No key, no files.** There's no plaintext fallback: without
  `ATHENA_DATA_KEY` an upload is refused, so a file is never stored
  readable. Deploy previews can't open files and never delete any (the blob
  store is shared between deploys; only a deploy with the key tidies up).
- **What's checked.** The type comes from the bytes, not the name: JPEG,
  PNG, WebP, GIF, PDF, or valid UTF-8 text with no NULs. Anything else is
  refused, so nothing executable or HTML is stored. 4 MB a file; names lose
  folders and control characters.
- **Summary and words.** The first time Claude reads a file it writes a
  short summary (`summary`), and a PDF's or text file's words are kept
  (`extracted_text`). Both are sealed like `name` and are in `ENCRYPTED`;
  both go when the row goes. The summary also travels inside the
  conversation that holds the file (sealed with it on the server, readable
  in the device's copy) so Conversations search can find it.
- **What stays readable.** Type, size, a photo's pixel size, a PDF's page
  count, when it was added, and which note or conversation uses it.
- **Kept while used.** A note or a conversation keeps its files; archiving
  keeps them; deleting either for good, or taking a file off, deletes the
  file and its bytes once nothing else uses it. Deleting a note for good
  can also delete its files where a conversation still has them, if you
  tick the box (`DELETE /api/notes/:id?files=delete`); those conversations
  then show the file as deleted and drop its summary.
- **Rotation.** Each row records its key id; the backfill re-seals file
  bytes still under an old key, then the name with the rest.
- **On the device.** Files you've opened are cached in plaintext in the
  browser's Cache Storage, like the rest of the offline copy. Deleting a
  file from this device clears its cached copy here; another device clears
  its copy the next time it finds the file gone.
- **Finance and health (§1).** Files aren't classified. Don't add bank
  statements or medical letters here; `sensitive_blobs` is still the place
  for those.

### How it works

- **Cipher.** AES-256-GCM with a random 96-bit IV per value, the same code as
  §9 (`lib/secret-box.ts`). A value is stored as
  `enc:v1:<key id>:<base64url(iv ‖ ciphertext ‖ tag)>`; `v1` names the
  format, and the 4-byte key id says which key sealed it. GCM's tag means a
  changed value fails to decrypt rather than decrypting to something else.
- **Keys.** `ATHENA_DATA_KEY` is 32 random bytes (64 hex characters). HKDF
  derives three things from it: the encryption key, the blind-index key and
  the key id. It's separate from `CONNECTOR_ENCRYPTION_KEY` on purpose.
- **Where.** `lib/db.ts` seals every write through `sealer()` and its `q()`
  opens every sealed value in a result, including JSON built in SQL (a
  to-do's person) and arrays (tags). Callers — the API, MCP, the briefing,
  the collector — only ever see plaintext. `scripts/export-obsidian.ts` opens
  values with the same module.
- **Search.** Postgres can't search ciphertext, so the full-text index is
  gone (migration `0012`). Recall, keyword search and `@`-mention search
  read the live rows, decrypt them and match in the Function
  (`lib/text-search.ts`: English stemming, Postgres's stop words, quoted
  phrases, OR, -exclusions). Fine at personal scale (thousands of rows); at
  hundreds of thousands it would want a different design.

### Setting it up

Set the key for the **production context only**, keep your own copy (Netlify
won't show a secret again), then redeploy. `README.md` → "Encryption at
rest" has the exact commands. The short version:

```sh
# Generate it, keep it in your login Keychain, and set it on Netlify. It's never printed.
KEY="$(openssl rand -hex 32)" && security add-generic-password -a athena -s ATHENA_DATA_KEY -w "$KEY" \
  && netlify env:set ATHENA_DATA_KEY "$KEY" --secret --context production --scope functions; unset KEY
```

**Losing the key loses the data.** Keep a second copy in 1Password.

### Existing data: the backfill

A SQL migration never sees the key, so it can't encrypt what's already
there. `netlify/functions/encrypt-data.ts` is a scheduled function (every 5
minutes, production only) that seals, about 20 seconds at a time, whatever
isn't yet sealed under the current key. At personal scale that's done in
one to three runs.

- **Dual read.** Until a row is sealed it reads as plaintext; reads accept
  both, and lookups compare the plain value where there's no blind index
  yet. There's no downtime and no order to the steps.
- **Writes always seal** once the key is set, so the plaintext only shrinks.
- **Safe to repeat.** A run rewrites a row only if its encrypted columns are
  still exactly what it read, so an edit made meanwhile wins; it never
  touches `updated_at`; a second run finds nothing to do.
- **Watching it.** The app's sync status (the cloud button on mobile, the
  card at the foot of the sidebar on desktop) says "Encrypting your data · N
  items to go", then "Your data is encrypted at rest". `GET /api/encryption`
  has the detail per table, and Netlify's function log for `encrypt-data`
  logs one line per run.

### Without the key: previews, and mistakes

The first time production writes with the key, it records
`settings.encryption = { required: true, kid }`. Deploy previews inherit
that with their copy of the database, and so would production if its key
ever went missing:

- **Reads never crash.** A value that can't be decrypted shows as
  "Encrypted — open on athena.example.com" (no key here) or "Encrypted — can't
  be read with the current key" (a key, but not the right one). Ciphertext
  never leaves the server, and placeholders don't match searches.
- **Writes of text are refused, loudly**: the API answers 503 ("Athena can't
  save this right now: …") and MCP returns the same error. Nothing is ever
  stored readable once encryption is on. Changes without text (archive, a
  catch-up cadence) still work. A malformed key is refused the same way.
- **Placeholders are never saved back** over real ciphertext (409), and the
  app opens such a note read-only, so a value that a missing old key made
  unreadable can still be recovered later.
- Before the key is ever set, nothing changes: text is stored as it always
  was, so this can ship before the key does.

### Rotating the key

1. Generate a new key; keep a copy.
2. Set `ATHENA_DATA_KEY_PREVIOUS` to the **old** key and `ATHENA_DATA_KEY` to
   the new one (both production, secret), then redeploy. Every value says
   which key sealed it, so old values still open, and lookups try every
   key's blind index.
3. The backfill re-seals every sealed store under the new key and
   recomputes the blind indexes: the tables in "What's encrypted" (with
   `sensitive_blobs` in every domain, `days.private`, `place_geo`, nudges,
   Ask's plans, routines, activity and skills, and a note's link choices),
   the two sealed `settings` values, file bytes, saved images and art. Link
   previews and cached place names under another key are dropped, not
   moved. The status shows it counting down to "encrypted".
4. Remove `ATHENA_DATA_KEY_PREVIOUS` and redeploy **only when the status
   reads "encrypted"**. It counts every one of those stores, and reads
   "encrypted" only when nothing in any of them is left under another key.

A value that won't decrypt during a rotation (altered, or sealed under a key
you didn't list) is left exactly as it is and counted in the run's log line;
the rest of its row is still re-sealed, and it doesn't hold up the rows
behind it. It stays counted, so the status stays at "encrypting" for as long
as it exists (owner, 10 Nov 2026: left in place). In that case the old key
is the only thing that could still open it.

Two effects of a rotation outside the backfill: a payment nudge can repeat
once (§1, "Money and home"), and a data key rotation does not touch what
`CONNECTOR_ENCRYPTION_KEY` seals: connector sign-ins, the map tile key, the
TMDB key and the ElevenLabs key. That key has no rotation path (§9).

### Known limits

- **Old plaintext lingers outside the live tables** until it ages out:
  Postgres's own history and backups from before the backfill, and any
  deploy-preview database branch made before the key went live. After the
  backfill, delete those preview branches (`netlify api
  listSiteDatabaseBranches` lists them).
- **The app's offline cache** on your phone and laptop is plaintext, as it
  always was: the device's own encryption and lock protect it. That
  includes health and money figures the app has shown. Sign out deletes it
  (§6). Sample mode keeps its notes in a database of its own
  (`athena-sample`), never beside the real cache.
- **Values aren't bound to their row.** Someone who can *write* to the
  database could swap one encrypted value for another (move a note's body to
  another note). GCM catches a changed value, not a moved one. Write access
  is outside this threat model.
- **Embeddings** (`note_chunks.embedding`) can't be encrypted and still
  searched in SQL. Nothing writes them yet; if semantic search is ever wired
  up, note that embeddings leak something of the text.
- **Logs** carry key ids and counts, never values. A database error from
  `q`, `qRaw` or `tx` is rethrown as `AthenaDbError`, which holds the
  Postgres code and the constraint name and nothing else: no SQL, no
  parameters, and the driver's error isn't kept as its cause. That is what
  reaches function logs, a collection run's error and MCP clients. An MCP
  tool error returns its own message only when it is an input error;
  anything else returns one fixed line and logs the error's name and code.
  The profile learner logs counts, suggestion ids and token counts, never
  what it learned. Two paths still pass the driver's own error, which can
  hold SQL and parameters: `lib/connectors.ts`, which has its own query
  function, and the three unused `sensitive_blobs` helpers at the end of
  `lib/db.ts`.
- **What MCP returns is labelled as content.** Every MCP tool that returns
  stored text wraps it as `{ content_notice, source, data }`
  (`netlify/lib/mcp/results.ts`): a fixed line saying `data` is content and
  not instructions, and which store and record sources it came from. The
  server's instructions say the same. It is a label for the calling model,
  not a control.

## 12. Voice: ElevenLabs and Talk

Talk (a spoken conversation in Ask) and, once it's connected, dictation use
your own ElevenLabs account. What that means:

**What goes to ElevenLabs.**

- **Your speech, while Talk is listening.** The app streams the microphone
  straight to ElevenLabs' realtime transcription (Scribe v2 Realtime) over
  a WebSocket and gets the words back. Only while the talk bar says
  *Listening*: the microphone is released before Athena thinks or speaks,
  after 12 seconds of silence, when you tap End, and the moment the app goes
  to the background.
- **Athena's replies.** The text Athena says back (the assistant's one or two
  sentences, a written answer's few sentences without their citation
  numbers, or a search answer's first line and top match) goes to
  ElevenLabs to be spoken (Eleven v4 Turbo). Notes, people, sources and the
  rest of the reply on screen aren't sent.
- **Dictation**, with ElevenLabs connected: each recording goes to ElevenLabs
  (Scribe v2) from the Function instead of to Gemini. If ElevenLabs fails it
  falls back to Gemini (README "Voice").
- **Voice samples** in the picker are played from ElevenLabs' own servers,
  only when you tap one.

ElevenLabs handles that audio and text under its own terms, and may keep
generated speech in your account's history. Its zero-retention mode is
only for enterprise plans, so Athena doesn't ask for it. Athena itself
stores none of it: no audio, no transcripts beyond the messages in Ask,
nothing in logs.

**Where the key lives.**

- In the `settings` table (row `elevenlabs`), sealed with AES-256-GCM under
  `CONNECTOR_ENCRYPTION_KEY`, exactly like connector sign-ins (§9). Without
  that key, adding one is refused rather than stored readable. Rotating it
  makes the stored key unreadable: add it again.
- It's checked with ElevenLabs before it's stored (listing voices and
  minting a listening token, both free) and then **never sent back**: the API
  returns whether it's connected, the voice and this month's usage, never the
  key. Nothing about it is cached on the device.
- **The browser never gets the key.** For listening, the Function mints a
  single-use token (`POST /v1/single-use-token/realtime_scribe`: one
  connection, gone after 15 minutes) and the app connects with that. For
  speaking, Eleven v4 Turbo is only available on ElevenLabs' Text to
  Dialogue WebSocket, which has no documented single-use token, so the
  Function opens that socket itself (key in the handshake header) and
  streams the audio back over HTTPS.
- **The Talk session socket.** A browser can't put the bearer token on a
  WebSocket, and Athena doesn't put it in a URL. The app asks
  `POST /api/talk/ticket` (bearer token, as any API call) for a ticket: 32
  random bytes, good once, for 30 seconds, from the IP that asked, held
  only in the server's memory. `GET /api/talk/session?ticket=…` is upgraded
  only with a good ticket; any attempt spends it. Another site's page can't
  get one (it has no token), so the socket needs no Origin check. The
  ticket and the upgrade count against the 30 a minute limit, and so does
  each reply spoken over the socket. The socket carries the line to speak
  up and audio down, never the ElevenLabs key.
- Logs name the ElevenLabs endpoint and status only, never the key, a
  token, audio or text.
- **Remove** in Connectors deletes the stored key. ElevenLabs still has it:
  delete it in your ElevenLabs account to revoke it.

**Limits and cost.** Every call spends your ElevenLabs credits (a credit per
character spoken; listening by the minute). `/api/talk/*` enters through the
Netlify Server (`netlify/server/`), which allows 30 requests a minute per IP,
counted in code, behind the same bearer token as the rest of the API;
`/api/elevenlabs` (status, voices, adding or removing the key) is the API's
normal bearer-token route.
A line to speak is capped at about 900 characters. The app ends a
listening turn after a minute; that cap is the app's own, and the listening
token itself lasts 15 minutes. If ElevenLabs refuses the key later, Connectors says so and
dictation goes back to Gemini until it's replaced.

## 13. Artwork and maps

Posters, covers, album art, game headers and day maps (`lib/art.ts`,
`lib/static-map.ts`, migration `0033`). The owner decided (7 Nov 2026) that
Athena keeps its own copy, and that maps are real, with the owner's own free
tile key.

- **The browser never contacts a third party for an image.** Art comes from
  `GET /api/art/:id`, maps from `GET /api/days/:date/map` (and one-pin
  stills from `GET /api/places/:id/map` and `GET /api/link-map`, §11 "Link
  previews and embeds"), all behind the bearer token, sent as WebP with
  `nosniff`.
- **Never people's photos.** Only artwork for films, shows, books, albums and
  games, and, in Watch & read only, a YouTube video's own thumbnail (owner
  decision, 10 Nov 2026: a thumbnail can show a presenter, and is the
  video's published cover). Days entries from YouTube still get none.
  Avatars and profile images are never asked for.
- **What's fetched, and from where.** https only, from a fixed allowlist of
  image hosts (`ART_HOSTS`: Letterboxd, Spotify, Last.fm, Steam, Open Library
  and its archive.org machines, TMDB, Deezer's cover host
  `cdn-images.dzcdn.net`, and YouTube's thumbnail host `i.ytimg.com`) plus
  four JSON lookups (Open Library search, TMDB search, Deezer's search for
  album covers, and MusicBrainz's artist search for Music's genres, below).
  A thumbnail on the owner's Plex or Jellyfin server is
  fetched from that host only, and that server's token goes to no other host.
  Every redirect hop is checked against the same list, and every host is
  resolved and refused if it lands on an internal address (the connector icon
  guard, §9). 6 seconds and 6 MB at most per image; the bytes must be a JPEG,
  PNG, WebP or GIF, whatever the header says. Images are re-encoded (two WebP
  sizes, metadata dropped) before they're kept.
- **What's kept.** The two sizes, sealed under the data key in Netlify Blobs
  (`athena-art`). The `art` table holds a blind-index id, pixel size, a
  average colour and the key id; `art_sources` holds a blind index of each
  source (address, ISBN or title) and which art it gave. No address, title or
  ISBN is stored readable. Without the data key no art is fetched or kept.
- **Covers on Ask's sources** (`lib/answer-art.ts`). A film, show, video,
  book, game, album or track an answer cites is shown with its cover, and
  so is a Watch & read title. Only sources a tool really returned get one
  (an invented link is dropped before this), and the source's own address
  is never fetched: the cover is looked up the same way as above, from the
  id in a Spotify, YouTube, Letterboxd or Steam link, or by title from TMDB
  and Open Library, off the same host list, within 1.5 seconds. An artist
  gets none. A web link in Ask's text is still a plain link with no
  preview (§11, M6).
- **What Watch & read learns about a title** (`netlify/lib/watch-enrich.ts`,
  `lib/watch-meta.ts`). After `GET /api/reading` replies, items not yet
  looked at are asked about once, within 8 seconds a load: a YouTube
  video's length, topics and category from the Data API's `videos` (50 ids
  a request, through the connected YouTube account, `youtube.readonly`) and
  its playlists from the saved entries Days already holds; a film's or
  show's genres, running time, year and keywords from TMDB's search and
  details when a TMDB key is set, otherwise from Trakt's summary for items
  Trakt synced; a book's year, pages and subjects from Open Library's
  search. What's sent is the title (and year or author) or the id the item
  already holds, to the service it came from or to the two lookups art
  already uses. The answer is kept sealed in `reading_items.meta`; your
  tags live there too and no source writes them. Nothing is sent to a
  model. `GET /api/watch-stats?month=YYYY-MM` adds up a month from
  Days' watched entries and those running times (`lib/watch-stats.ts`); it
  reads only, and asks nothing of any service. With `from` and `to` it
  gives screen time over up to 92 days against the same stretch before.
- **What Music learns about an artist** (`netlify/lib/music-genres.ts`,
  owner decision, 15 Nov 2026: performers aren't contacts, so an artist's
  name may go to a music lookup). After `GET /api/life/music` replies, the
  period's artists whose genres aren't known are asked about, most played
  first, at most 12 and 8 seconds a load. Spotify first when a Spotify
  account is connected (`/search?type=artist` with the artist's name,
  through that account), then MusicBrainz's artist search (no key, no
  account; `musicbrainz.org`, added to the JSON lookups, one request a
  second). Only the artist's name is sent: never an album, a play, a date
  or anything about the owner. What comes back (the genres, which source,
  when) is kept sealed in one settings row (`settings.music_genres`, no
  migration); an artist neither knew is asked again after a month. Nothing
  is sent to a model.
- **Album covers by name** (owner decision, 15 Nov 2026: plays imported
  without a cover left most artists blank). A listened entry whose source
  sent no image and no Spotify link is looked up on Deezer's search (no
  key, no account): the album and artist, a track and artist for Apple
  Music's track rows, or the artist alone for a play titled with the
  artist, which takes their best-known album's cover. Only a result by
  exactly that artist counts. It is always an album's cover, never a photo
  of the artist. Podcasts and audiobooks are never looked up. Music
  (`lib/music-data.ts`) reads the covers already found on each load (one
  query, nothing fetched) and, after the reply, asks for the 30 most played
  still missing, within 8 seconds.
- **What leaves Athena for art.** The image request itself; for a book
  without an image, its title and author to Open Library; with a TMDB key, a
  film's or show's title and year to TMDB; for music without a cover, the
  album (or track) and artist name to Deezer. Each source is asked once; a miss
  is asked again after a fortnight.
- **Maps: what the tile provider gets.** Tile numbers (zoom, x, y), the style
  name and the owner's key. Never a place's name, id or coordinates; the
  route and markers are drawn by Athena over the tiles. The day's stops are
  read from the sealed places row (§1 "Places and visits") inside the
  Function.
- **Maps: what's kept.** Each drawn map, sealed in Blobs (`athena-maps`),
  keyed by a blind index of the stops, provider, style and size, so the key
  says nothing about where. A day whose places change gets a new map. The
  last good Settings test sample (a fixed spot in central London, nothing
  about the owner) is kept the same way.
- **Keys.** The tile key and the TMDB key are tried before they're kept, then
  sealed in `settings` (row `maps-art`) under `CONNECTOR_ENCRYPTION_KEY`,
  exactly like the ElevenLabs key (§12), and never sent back to the app. A key
  the provider later refuses is marked, and Settings says so.
- **On the device.** Art and maps the app has shown are kept in Cache Storage
  so they open offline, like opened files (§11 "Files").
- **Logs** name the step and status only: never a key, a place, a title or an
  image address.

## 14. Live flight times

OpenSky (`netlify/lib/live-flights.ts`), for Travelling today, the Trips
card, the push before a flight, the briefing and Ask's `flight_status`.

- **What leaves Athena.** A box of latitude and longitude around one
  airport. No key, no flight number, callsign, reference, seat, name or
  booking id; the callsign is matched inside Athena. Tests assert it.
- **How.** GETs to `opensky-network.org` only, through `publicFetch` (§9's
  SSRF guard: https only, every address checked as it's connected),
  redirects refused, 5 s timeout.
- **Limits.** In-memory cache of 2.5 minutes per airport; a 429 rests it
  until OpenSky says; it stops 10 credits short of the anonymous daily
  allowance. A flight is only asked about from 45 minutes before it's due to
  leave (near its airport) and near landing.
- **No credentials.** The Sources entry holds nothing. Another provider would
  plug in behind `FlightProvider` in the same file, and any key it needs
  would be a sealed connector credential (§9).
- **Logs** name the host and status only.

## 15. Live travel keys

Google Maps (routes), TfL and National Rail live departures are Sources
accounts with a pasted key (`lib/presets/live-travel.ts`). Athena calls them
itself for Leave by (§8), the briefing, Travelling today and Ask's
`train_status`. No collection or Claude reads them, and they offer no tools.

- **Where keys live.** Each key is a connector credential: sealed in
  `connectors.credentials` under `CONNECTOR_ENCRYPTION_KEY` with the
  account's other secrets (§9), like any pasted token. The API returns only
  `has_token`, never the key.
- **Which key is used** (`netlify/lib/travel-key.ts`, `travelKey`). The
  newest account's stored key first. If there's none, the old environment
  variable (`ATHENA_GOOGLE_ROUTES_KEY`, `ATHENA_TFL_KEY`, `ATHENA_RDM_KEY`),
  so a deploy that already set one keeps working. If neither, that feature
  is off. Stored keys are read at most once a minute per function instance
  and held only in memory. Settings → Notifications learns whether Leave by
  has a planner as two yes/no values, never a key.
- **What's sent.**
  - Google Routes: two coordinates (5 decimal places) and an arrival time.
    The key goes in the `X-Goog-Api-Key` header.
  - TfL: for journeys, two coordinates and an arrival time; for line status,
    nothing but the key, which goes in the query as `app_key`, as TfL asks.
  - National Rail: two station codes and a time window, with the key in the
    `x-apikey` header.
  - Never a name, an address, an event title, a booking reference or a
    person.
- **Check connection** (`netlify/lib/connectors/live-travel-direct.ts`)
  makes one small read-only call: a walking route between two fixed points
  beside Trafalgar Square, the Victoria line's status, or one row of King's
  Cross's departure board. Nothing about the owner is sent. A refused key
  marks the account "needs attention" with a message that never contains it.
- **Cost.** Google needs a billing account on the key's project, and gives a
  monthly free allowance. Athena asks Google once per upcoming event at a
  Place, within 90 minutes of it: one request by public transport, and a
  second on foot only if there's no transit route. A drive is one request,
  plus one traffic recheck near the leave time. The answer is kept until
  the event starts. The owner should restrict the key to the Routes API.
- **Logs** name the host and status only. Tests assert that no key appears
  in a log line or an answer (`netlify/lib/proactive/directions.test.ts`,
  `lib/live-travel.test.ts`).

## 16. The car: DVLA and DVSA

The owner's car comes from two government APIs, each a Sources account in
Places and travel (`lib/presets/car.ts`): DVLA's Vehicle Enquiry (one API
key) and DVSA's MOT History (an API key, a client ID, a client secret and a
token URL). Athena calls them itself (`netlify/lib/car-api.ts`), read only.
No collection or Claude reads them, and they offer no tools.

- **A registration number is personal data.** It's kept in one place: the
  `settings` row `car`, whose value is `{ sealed }`, the whole car state
  (registrations, both APIs' answers, which Life admin items track what)
  sealed with the data key (§11, `lib/car-store.ts`). Nothing about the car
  is readable in the database. No migration.
- **Where it goes.** Only to the two APIs: DVLA in a POST body
  (`{ "registrationNumber" }` to
  `driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles`, never in
  the URL, as DVLA asks), and DVSA in the path of
  `history.mot.api.gov.uk/v1/trade/vehicles/registration/{reg}`. DVSA's
  sign-in (`login.microsoftonline.com`, client credentials, scope
  `https://tapi.dvsa.gov.uk/.default`) hears the client ID and secret, never
  a registration. The token URL must be on `login.microsoftonline.com` and
  is checked when it's saved and before every use, so the secret goes
  nowhere else.
- **What comes back to the app.** `GET /api/car` gives the owner's own app
  each vehicle's card, with its registration, behind the same bearer token
  as every route. The app doesn't cache it. Life admin items are named by
  the car ("Ford Focus MOT"), nudges and pushes by the car's label, and
  Ask's `car_details` leaves the registration out. Two cars with the same
  label get the first four characters of their plates.
- **When.** Once a day per vehicle, from the reminders function, and when
  the owner adds a car or taps Check again. A failed read waits for the next
  day, so a busy API isn't asked every 5 minutes. DVSA's token is held in
  memory until a minute before it expires.
- **Keys** are connector credentials sealed under `CONNECTOR_ENCRYPTION_KEY`
  (§9). `GET /api/car` says only whether each is set up. "Check connection"
  sends a registration too short to be real (`A`), so the service checks the
  key and nothing about the owner is sent.
- **Removing a car** drops its registration and answers from the sealed row,
  archives its Life admin items and closes its nudges.
- **Logs** name a host and a status only. `netlify/lib/car-routes.test.ts`
  asserts that the registration reaches only the two APIs' hosts and never a
  log line.
