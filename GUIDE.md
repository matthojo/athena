# Athena guide

How each part of Athena works, in more depth than the README. For the
system design see [ARCHITECTURE.md](ARCHITECTURE.md); for what's encrypted
and who can read it, see [SECURITY.md](SECURITY.md).

- [Ask: questions and instructions](#ask-questions-and-instructions)
- [Reminders and the morning briefing](#reminders-and-the-morning-briefing)
- [Voice](#voice)
- [Connectors: Athena collects from your accounts itself](#connectors-athena-collects-from-your-accounts-itself)
- [Encryption at rest](#encryption-at-rest)
- [Collection agents as Claude routines (optional)](#collection-agents-as-claude-routines-optional)

## Ask: questions and instructions

Ask answers questions from everything: "What did Gayle say about pricing last
month?" Claude searches your notes, people and to-dos and, live, the accounts
you've connected (Granola calls, Gmail, Calendar, Slack…), then writes a few
sentences with numbered sources. Tap a source to open the note, person or
to-do, or the call or email in its own app. Every source is checked against
what Athena found, so a link is never made up; when there's nothing,
it says so. Under the answer: "Searched your notes, 2 calls and Gmail", and
any account it couldn't reach. It takes about 15–25 seconds, uses AI Gateway
credits (`ATHENA_ANSWER_MODEL` changes the model) and shares the assistant's
rate limit.

Offline, or if an answer can't be had, Ask falls back to a keyword match
across your notes, people and to-dos, which never makes things up and works
offline. Sample mode has one written answer: ask "What did Elena say about
pricing?"

Tell it to do something instead and Claude does it, setup included:

- "Add the Lego Technic Ferrari to Rowan's Christmas gift ideas" finds
  Rowan (or asks which Rowan, or whether to add her), finds or starts her
  **Rowan — Christmas gift ideas** checklist, linked to her, and adds the
  item once.
- "Remind me to call Mum on Sunday at 6", "I owe Ricardo the staging plan",
  "Priya's moving to Lisbon", "Tick off book the dentist".

Every change is listed under the reply with **Open** and **Undo**. Undo
archives what was added or puts back what was there. Nothing is ever
deleted.

It runs through Netlify AI Gateway like collections do (Claude Sonnet 5.5;
`ATHENA_ASSISTANT_MODEL` changes it), rate-limited to 20 requests a minute.
It needs a connection and doesn't work in sample mode.

## Reminders and the morning briefing

`netlify/functions/reminders.ts` is a Scheduled Function that runs every 5
minutes (Netlify runs scheduled functions on production deploys only, not
deploy previews). "07:30" and "today" are in your time zone: the app tells
the server which zone your device is in, so they follow you when you travel
(Europe/London until a device has reported one). The same goes for to-dos
due today or overdue, and for your own reminders: a one-off reminder comes
at the moment you picked, and a repeating one keeps its time of day where
you are (an 8am reminder comes at 8am in New York when you're there). It
does three things:

- **07:30**: writes **Today, …** into your notes (type `daily`, source
  `briefing`). The note lists today's events, what's coming up, today's
  meeting notes from `calendar-meetings`, who to catch up with, and
  yesterday's captures. It then pushes a digest that opens that note.
  Birthdays and all-day events appear in the digest on each of their
  "remind me" days.
- **30 minutes before** any event with a time, it sends a push.
- **Your own reminders**, when they're due (within 5 minutes). Ask for one on
  the **Reminders** page ("Remind me to…", a day, a time, and optionally a
  repeat: every day, weekday, week, month or year), or ask Claude through the
  MCP server (`create_reminder`: "remind me to call the plumber at 5pm"). A
  reminder can be about a person, note, place, organisation or event, and
  tapping the notification opens it. Today's reminders are also listed in
  the morning briefing. A one-off is marked done once sent; a repeating one
  moves to its next time, keeping its wall-clock time across the clocks
  changing (and coming back to the 31st after a short month).

  REST: `GET /api/reminders` (`?include_done=1`), `POST /api/reminders`
  (`{ text, date, time, repeat?, about?: { kind, id } }`, or `at` as an ISO
  instant), `PATCH /api/reminders/:id` (any of those, or `done`), `DELETE
  /api/reminders/:id`.

The briefing works without push. Push needs no setup of its own: Athena
makes a notification key pair the first time it needs one and keeps it,
sealed under `ATHENA_DATA_KEY` ("Encryption at rest", below). If you'd
rather use your own pair, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`VAPID_SUBJECT` on the production site and redeploy; those win when set.

To get notifications on your iPhone (iOS 16.4+), add Athena to the Home
Screen and open it from there. Go to **Settings → Notifications**, tap
**Turn on notifications**, allow them, then tap **Send a test**. The same
screen chooses which kinds you get and the quiet hours.

With no `ATHENA_DATA_KEY` and no VAPID keys, `/api/push/key` returns
`null`, Settings → Notifications says notifications aren't ready, and the
function logs `Athena push: no VAPID keys in the environment and no
ATHENA_DATA_KEY to keep Athena's own` instead of failing. Your own
reminders wait, shown as overdue on the Reminders page, and are sent on the
first run once push works.

## Voice

Two places take speech:

- **Dictation in notes.** The mic at the end of a note's formatting toolbar
  records; while you speak, a marker shows where the words will land, and
  they're inserted there as plain text (you can keep typing elsewhere while
  it transcribes). Recordings stop at 3 minutes.
- **Spoken questions in Ask.** With the box empty, its button is a mic; the
  transcript is asked exactly as if you'd typed it. Questions stop at 30
  seconds.

The recording goes from the browser (MediaRecorder: Opus/WebM in Chrome,
AAC/MP4 in Safari) to `POST /api/voice/transcribe` (bearer auth, like every
other `/api` route), which sends it to **Google Gemini `gemini-3.5-flash`
through Netlify's AI Gateway** and returns the text. Nothing to set up: the
gateway injects `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` into functions
automatically (the site needs AI features enabled and at least one production
deploy). Audio and transcripts are never stored or logged.

**It spends AI Gateway credits.** A minute of speech is about 1,500 input and
200 output tokens: roughly $0.004, or **0.8 credits per minute**; a short Ask
question is about 0.1 credits. To keep a stuck client or a leaked token from
running that up, `/api/voice/*` is rate-limited to 10 requests a minute per
IP, bodies are capped at 4 MB, recordings that never rise above room noise
are dropped on the device, and the model's reply is capped.

Why Gemini and not OpenAI: the gateway only forwards JSON request bodies, and
OpenAI's transcription endpoint only accepts multipart uploads, so it's
rejected (`400 invalid_content_type`); OpenAI's speech (TTS) and Realtime
endpoints aren't routed at all. Gemini takes audio inside JSON. The gateway
offers no text-to-speech model, which is why speaking needs your own
ElevenLabs account (below). `lib/voice.ts` is the only file that knows the
gateway's provider, so switching is a change there.

Offline, the mic is dimmed and says it needs a connection. If the microphone
is blocked, the bar says how to allow it. Sample mode uses a canned
transcript and no microphone.

### Talk, with your own ElevenLabs account

**Talk** turns Ask into a spoken conversation: tap the orb beside the mic,
say what you want, and Athena answers out loud, then listens again until you
tap **End**. It needs your own ElevenLabs account:

1. In ElevenLabs, open **API keys** and create a key (if you restrict it,
   allow Text to Speech, Speech to Text, Voices and User read; leave the IP
   allowlist off, since Athena's functions don't have fixed addresses).
2. In Athena, open **Settings → Voice**, paste the key
   and tap **Connect ElevenLabs**.
3. Pick a voice (tap ▶ to hear one first), and tap **Hear it** to check it.

The key is stored sealed under `CONNECTOR_ENCRYPTION_KEY` (already set for
connectors) and never comes back to the app. Each turn: the app streams
your voice (16 kHz PCM, Web Audio, not MediaRecorder) straight to
ElevenLabs' **Scribe v2 Realtime** over a WebSocket, using a single-use
token minted by `POST /api/talk/listen` (the key stays on the server); a
pause of about a second ends the turn. The words go through Ask exactly as
if typed (search, or the assistant with its receipts and choices). The
reply is spoken with **Eleven v4 Turbo** (`eleven_v4_turbo`), which
ElevenLabs only offers on its Text to Dialogue WebSocket, so
`POST /api/talk/speak` opens that socket from the server with your key
and streams the audio back as raw PCM. The microphone is open only while
Athena is listening, tapping the orb while Athena speaks stops the reply
and listens, and leaving the app ends Talk. Nothing said for 12 seconds
pauses it and turns the microphone off.

With ElevenLabs connected, dictation and spoken Ask questions use
**Scribe v2** too; without it (or if ElevenLabs fails) they stay on Gemini.

**It spends your ElevenLabs credits**, not AI Gateway's: one per character
Athena says, and listening by the minute. Settings → Voice shows this month's
usage. `/api/talk/*` is rate-limited to 30 requests a minute per IP.

Running it locally with `netlify dev`: the local gateway token is bound to the
IPv4 address the CLI used, so start it with
`NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"`
or calls fail with `403 mismatched_client_ip`.

## Connectors: Athena collects from your accounts itself

Athena signs in to remote MCP servers itself (Gmail, Google Calendar,
Granola, Linear, Slack, GitHub, Notion, or any Streamable HTTP MCP server)
and collects from them on a schedule, without a Claude routine in between.
Each **connector** is one signed-in account, so the same service can be
added as often as you like: *Work Gmail* and *Personal Gmail* are two rows,
each with its own label, and everything they produce stays apart
(`email-digest-work` vs `email-digest-personal` notes, `…_work` vs
`…_personal` metrics).

Open **Settings** (sidebar foot on a Mac, header menu on a phone). Its
**Connectors** group has a page each for Accounts, Collections, Voice and
From your iPhone:

1. **Accounts → Add an account** → pick the service, name it, give it a label (`work`,
   `personal`) and sign in. OAuth servers that allow it register Athena
   automatically. **Google doesn't**, so for Gmail and Calendar create an
   OAuth client in a Google Cloud project (type *Web application*, with the
   Gmail API or the Google Calendar API turned on), add the redirect URI the
   form shows (`https://<site>/api/connectors/oauth/callback`) and paste its
   ID and secret. One client serves every Google account you add. Athena
   asks Google for read-only scopes, and calls Google's ordinary Gmail and
   Calendar APIs itself: Google's MCP servers for them are in a Developer
   Preview most accounts can't use (see ARCHITECTURE.md to switch an
   account to them later). **Microsoft doesn't either**: for Outlook and
   Outlook Calendar, register an app once at entra.microsoft.com (App
   registrations → New registration, accounts in any organisation and
   personal Microsoft accounts, redirect URI type *Web*), then paste its
   Application (client) ID and a client secret's Value. One app serves
   every Microsoft account. Athena asks for read-only access and calls
   Microsoft Graph itself. GitHub takes a fine-grained read-only token;
   Linear takes OAuth or an API key.
   **For the Life log** (Entertainment): Trakt needs a free app of your own
   at trakt.tv/oauth/applications with the same redirect URI (just its Client ID: it signs in with PKCE, no secret); YouTube uses
   your Google client with the YouTube Data API v3 turned on (YouTube
   shares likes, playlists and subscriptions, not watch history);
   Letterboxd and Goodreads only need your public profile link.
   Custom servers show the name and logo they advertise. If they don't
   advertise a logo, Athena uses their website's icon.
   **Custom servers on plain OAuth 2.** Most MCP servers publish their
   OAuth settings and Athena needs nothing more. For one that doesn't (a
   server behind Auth0, Okta, Keycloak or your own identity provider), open
   **OAuth settings** and paste the provider's authorization and token URLs
   with your own client ID and secret (add the redirect URI the form shows to
   that client). If the server grants access to an app rather than a person,
   choose **Flow → Client credentials**: Athena swaps the client ID and secret
   for a token with no browser sign-in, and gets a new one when it expires.
   **Audience** (required by Auth0) and **Client auth** (HTTP Basic or in the
   request body) are there for providers that need them. Changing any of these
   later signs the account out; paste just a new secret to rotate it.
2. **Tools**: Athena lists what the server offers and allows only the
   read-only ones by default. Tools that send, edit, label or delete are
   never allowed, and you can switch any allowed tool off.
3. **New collection** → choose a recipe (Meetings, Email digest, Work
   activity, or Custom instructions), the accounts it reads, a label, and a
   schedule (daily at a time in your zone, every few hours, or only when you press
   **Run now**). Runs show their summary, counts and any error.

4. **Upcoming events** (Meetings and Custom collections): sync the next 7, 14
   or 30 days of calendar events into Athena's Events. Synced events show up
   in Coming up and the morning briefing, and a moved event is updated in
   place. A synced event doesn't push 30 minutes before it unless you switch
   that on, since your calendar app probably already reminds you. The other
   people on the invite are linked to the event (and added to People if
   they're new, for meetings of up to 8 others), and once the meeting's
   notes are written, they're linked to it too.

**Keeping in step with the source.**
- Every record a collection writes is keyed to the source item's id.
- A rerun updates what it wrote before. If a meeting or event is cancelled
  or deleted at the source, its note or event is archived (not deleted).
- If a cancelled item comes back, its record is restored.
- If **you** archive or delete something a collection wrote, it stays gone:
  the collection won't write it again.
- Daily counts are one value per day, so running again the same day
  replaces the count instead of adding to it.

How it runs: `netlify/functions/collect.ts` is a Scheduled Function every 15
minutes that claims due collections and hands them to
`netlify/functions/collect-run.ts`, a Background Function (up to 15 minutes).
That runs Claude in a tool loop over the accounts' *allowed* tools plus a few
narrow Athena write tools (save a note, find-or-create a person/project,
link, record a metric). Reruns update the notes they wrote before rather than
duplicating them. If an account's sign-in expires, its collections skip it,
the page shows **Needs sign-in**, and (with push on) you get one notification
a day until you sign in again.

`CONNECTOR_ENCRYPTION_KEY` seals every sign-in. The Deploy to Netlify button
asks for it; if you set the site up another way:

```sh
netlify env:set CONNECTOR_ENCRYPTION_KEY "$(openssl rand -hex 32)" --secret
```

Claude is reached through **Netlify AI Gateway**, which needs no key: it
activates after the site's first production deploy on a credit-based plan.
To use your own key instead, set `ANTHROPIC_API_KEY` as a secret.
Collections default to Claude Sonnet 5.5; set `ATHENA_COLLECTOR_MODEL` to
`claude-opus-5-5` for the subtlest extraction or `claude-haiku-5-5` for the
lowest cost. AI Gateway caps your team's spend per minute; a run that hits
the cap waits for the next minute and carries on.

**Jev keeps collections cheap.** Jev is TypeSafe's yes/no-and-choices
model on AI Gateway: about 50× cheaper than Sonnet to read, with free
output. Before a scheduled run starts Claude, Athena checks each account
itself:

- **Nothing new** since the last good run (Granola: no meetings updated;
  Gmail: no new threads) and Claude isn't started at all. The run history
  says "Nothing new, so Claude wasn't needed".
- **New email** is sorted by Jev in one call: needs you, receipt, worth
  knowing, or noise. Claude is told which threads to read and skips the
  newsletters and notifications.
- **Everything Claude reads** from your accounts is checked by Jev for text
  trying to instruct an AI; anything that looks like it is flagged as data
  before Claude sees it.
- **How sure a to-do or detail is** comes from Jev's calibrated probability
  rather than Claude's own guess. That decides between To do and the Review
  inbox.

Run now always runs in full, and if Jev isn't available every step falls
back to what it did before. Ask uses Jev too, to tell an instruction from a
question when the wording is ambiguous.
Scheduled functions only run on production deploys; on a deploy preview use
**Run now**. See `SECURITY.md` §9 for how credentials are protected.

## Encryption at rest

What you write (notes, people's details, events, reminders, to-dos,
catch-ups, facts, life admin, reading and goals) is stored encrypted in the
database. Athena decrypts it as it reads, so everything works as before: the
app, Ask, the morning briefing, collections and Claude. What it guards
against is anyone or anything that can read the database without the key: a
backup, a dump, the database console, or a deploy preview's copy of your
data. Previews have no key, so they show "Encrypted — open on
athena.example.com" instead of your content, and won't save changes. (The
server holds the key, so this isn't end-to-end encryption; see
`SECURITY.md` §11 for exactly what is and isn't encrypted.)

Setting the key is step 2 of "Deploy your own" in the README. Once it's set
and production is redeployed, everything new is encrypted as it's saved, and
`netlify/functions/encrypt-data.ts` encrypts what was already there, a batch
every five minutes. The sync status in the app (the cloud button on mobile,
the card at the bottom of the sidebar on desktop) shows "Encrypting your data
· N items to go" and then "Your data is encrypted at rest". Netlify's
function log for `encrypt-data` shows the same, one line per run.

To change the key later, see "Rotating the key" in `SECURITY.md` §11: the
old key goes in `ATHENA_DATA_KEY_PREVIOUS` while everything is re-encrypted.

## Collection agents as Claude routines (optional)

Before connectors, collection ran as scheduled Claude cloud routines, and
that still works if you'd rather. `.claude/agents/` holds the specs for
`calendar-meetings`, `work-activity`, `email-digest` and `finance`: what each
reads, through read-only MCP connectors on your claude.ai account, and what
it writes back through the Athena MCP server's tools. The `finance` spec
writes no figures, only that a snapshot was taken (`SECURITY.md` §1).

`.claude/skills/register-collection-agent/SKILL.md` registers one as a
routine on whichever claude.ai account your Claude Code session is signed in
to, with a source label so work and personal data stay apart. Open this repo
in Claude Code and run the skill; it checks the connectors, builds the
prompt and sets the schedule.

Connectors (above) do the same job inside Athena, with any number of
accounts per service and the read-only rule enforced in code. If a
connector-based collection covers a domain, turn the matching routine off
at claude.ai/code/routines so the two don't both write.
