<p align="center">
  <img src=".github/readme/logo.png" width="112" height="112" alt="">
</p>

<h1 align="center">Athena</h1>

<p align="center">
  A personal second brain that you host yourself, on your own Netlify site.
</p>

<p align="center">
  <a href="https://app.netlify.com/start/deploy?repository=https://github.com/matthojo/athena"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify" height="32"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2c6be7" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/runs%20on-Netlify-2c6be7" alt="Runs on Netlify">
  <img src="https://img.shields.io/badge/node-24-2c6be7" alt="Node 24">
</p>

<p align="center">
  <img src=".github/readme/home.webp" alt="Athena's Home page on a desktop: a morning greeting, the Ask box, and today's train, flight, car hire and hotel in a row" width="100%">
</p>

Athena keeps your notes, people, to-dos and days in one Postgres database on
a Netlify site that you own. It collects from the accounts you connect, such
as Gmail, Calendar, Slack and Linear, and Claude answers questions about all
of it, with sources. You can use it from your phone, your Mac or any
MCP client.

Each copy belongs to one person and runs on their own Netlify account, so
the project never sees your data.

<p align="center">
  <img src=".github/readme/days.webp" width="31%" alt="Days on a phone: last night's sleep, morning and evening questions, habits and a mood picker">
  &nbsp;
  <img src=".github/readme/week.webp" width="31%" alt="Week in review on a phone: time with Priya and Tom, a four-day trip to Lisbon">
  &nbsp;
  <img src=".github/readme/team.webp" width="31%" alt="Team on a phone: assistants called Muse and Dot, one waiting for your Go">
</p>

<p align="center"><sub>Screens from sample mode. Every person and number in them is made up.</sub></p>

## What it does

- **Linked notes, people and to-dos:** along with projects, places,
  organisations, events, reminders, goals, habits, saved links, recipes, and
  things to watch and read. A note that mentions someone shows up on their
  page.
- **Ask:** "What did Gayle say about pricing last month?" Claude searches
  your notes and, live, the accounts you've connected. It answers in a few
  sentences with numbered sources, and checks each source against what
  Athena found. It also carries out instructions ("Remind me to call Mum on
  Sunday at 6", "I owe Ricardo the staging plan") and lists every change
  with **Undo**.
- **Days:** a daily log of sleep and steps (from Apple Health, Oura, Strava
  or Withings), habits, mood, a journal, where you went (Google Maps
  Timeline, Swarm), and what you watched, read and listened to.
- **Collections:** Athena signs in to Gmail, Google Calendar, Outlook,
  Granola, Linear, Slack, GitHub, Notion or any MCP server, with read-only
  tools, and on a schedule Claude turns what's new into notes, to-dos and
  events.
- **Team:** assistants you set up, which run on a schedule or when something
  arrives (a new Linear issue, a saved link). A change you haven't allowed
  waits for your **Go**.
- **A morning briefing and reminders:** a note at 07:30 in your time zone,
  and push notifications, including on iPhone once Athena is on your Home
  Screen.
- **Voice:** dictation in notes and spoken questions in Ask. With your own
  ElevenLabs key, **Talk** answers out loud.
- **Works offline:** it installs as an app and keeps a copy on the device.
  Changes made offline are sent when you're back online.
- **Open to your other tools:** an MCP server for Claude, a REST API, iPhone
  Shortcuts and a browser extension (with keys that can only add things),
  and an Obsidian-compatible markdown export.

The [guide](GUIDE.md) goes through each of these in detail.

## Your data stays on your site

- **Your own keys:** your site has its own database and keys, and the keys
  live only in its Netlify environment.
- **Encrypted at rest:** what you write is stored encrypted with AES-256-GCM,
  under a key only your production functions hold. Deploy previews get a
  copy of the database but not the key, so they show "Encrypted — open on
  your-site" instead of your content.
- **Sensitive figures sealed apart:** health, location, money and home
  figures go in a table of their own and are opened only when a page asks
  for them. Ask can read spending only after you switch that on.
- **Read-only access to your accounts:** collections get only read-only
  tools, and anything that sends, edits or deletes is never offered to
  Claude. Account sign-ins are sealed under a second key.
- **Not end to end:** your server holds the keys, so someone with both your
  Netlify environment and your database could read your data.

[SECURITY.md](SECURITY.md) has the full model, including what it doesn't
cover. Athena is a personal tool. It hasn't had an
independent audit, and it doesn't claim to meet HIPAA or any other
compliance standard.

## Deploy your own

You'll need a Netlify account on a credit-based plan (Netlify Database and
AI Gateway need one), and about ten minutes. Claude runs through Netlify AI
Gateway, so there's no Anthropic key to set up; it uses your Netlify credits.

### 1. Deploy

Press **Deploy to Netlify** above. Netlify sets up a new site from this
repository and asks for four values:

| Variable | What it's for |
|---|---|
| `SITE_PASSWORD` | The password you type to open Athena in a browser. Choose your own. |
| `SESSION_SECRET` | Signs your browser session |
| `MCP_BEARER_TOKEN` | Your master token, for connecting the app and making API keys |
| `CONNECTOR_ENCRYPTION_KEY` | Seals your account sign-ins |

Make each of the last three with `openssl rand -hex 32`. Keep a copy of
`MCP_BEARER_TOKEN`; you'll paste it in step 3. The first deploy creates the
database and sets up its tables.

### 2. Set the data key for production only

This key encrypts your content. Set it for the production context alone, so
deploy previews can't read their copy of your data. With the
[Netlify CLI](https://docs.netlify.com/cli/get-started/), in a clone of your
new site's repository:

```sh
netlify link
KEY="$(openssl rand -hex 32)"
netlify env:set ATHENA_DATA_KEY "$KEY" --secret --context production --scope functions
echo "$KEY"   # save this in your password manager now
unset KEY
```

On a Mac you can keep it in your login Keychain instead of printing it:

```sh
KEY="$(openssl rand -hex 32)" && security add-generic-password -a athena -s ATHENA_DATA_KEY -w "$KEY" \
  && netlify env:set ATHENA_DATA_KEY "$KEY" --secret --context production --scope functions; unset KEY
```

> [!IMPORTANT]
> If you lose this key, you lose your data. Netlify won't show a secret
> again, so keep your own copy somewhere safe.

Then redeploy production (**Deploys → Trigger deploy**) so the functions
pick the key up.

### 3. Sign in

Open your site, type your `SITE_PASSWORD`, choose **Connect** and paste
your `MCP_BEARER_TOKEN`. The app exchanges it for a key of its
own, just for that device, and doesn't keep the token. Do the same on each
device.

### 4. Add what you use

Each of these is optional:

- **Accounts and collections:** Settings → Connectors. Google and Microsoft
  need an OAuth app of your own; the [guide](GUIDE.md#connectors-athena-collects-from-your-accounts-itself)
  walks through it.
- **Notifications:** Settings → Notifications. On iPhone, add Athena to your
  Home Screen first.
- **Claude:** see below.

## Updating

Pull this repository's `main` branch into your copy. Netlify deploys it and
applies any new database migrations before the new version goes live.

## Use it from Claude

Make a key in **Settings → API keys** and choose **Claude only**. It opens
Athena's MCP tools and nothing else. Then, in Claude Code:

```sh
claude mcp add --transport http athena https://<your-site>/mcp \
  --header "Authorization: Bearer <your Claude-only key>"
```

Claude can then search and read your notes, people and to-dos, and add to
them. The MCP tools can't delete anything permanently.

## Try it locally

You don't need an account to look around. Sample mode runs the app in your
browser on made-up data:

```sh
git clone https://github.com/matthojo/athena.git athena
cd athena
npm install
npm run dev:app
```

Open http://localhost:5173 and choose **Continue with sample data**. Ask
works in sample mode for one question: "What did Elena say about pricing?"

To run the functions and MCP server too, use `netlify link` and then
`netlify dev` (http://localhost:8888). It starts a local database of its
own, separate from your site's; set up its tables with
`netlify database migrations apply`. The data key stays on production, so
`netlify dev` never has it: anything encrypted shows as "Encrypted — open
on …".

## Export to Obsidian

```sh
ATHENA_DATA_KEY="$(security find-generic-password -a athena -s ATHENA_DATA_KEY -w)" npm run export:obsidian
```

Run it from your linked clone, with your site's database connection string
in the environment ([SECURITY.md](SECURITY.md) §4). It writes a markdown
vault to `export/obsidian-vault/`, which is git-ignored. It's a one-off
snapshot, not a sync. The files it writes are readable, so keep them
somewhere safe.

## Documentation

- [GUIDE.md](GUIDE.md): Ask, reminders and the briefing, voice, connectors
  and collections, and encryption, in detail
- [ARCHITECTURE.md](ARCHITECTURE.md): how the system fits together, and why
- [SECURITY.md](SECURITY.md): the security model, and how to report a
  vulnerability
- [extension/README.md](extension/README.md): the "Save to Athena" browser
  extension

## Contributing

Issues and pull requests are welcome. Please report security problems
privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue.

Tests use Node's test runner through `tsx`:

```sh
npx tsx --test 'lib/*.test.ts' 'app/src/**/*.test.ts' 'netlify/**/*.test.ts'
```

Files named `*.db.test.ts` need a Postgres database with the migrations in
`netlify/database/migrations/` applied. Point `ATHENA_TEST_DB_URL` at it and
run `npm run test:db`. The browser extension has its own tests:
`cd extension && npm test`.

## License

Athena is free software under the [GNU Affero General Public License
v3.0](LICENSE) or later. You can use, change and share it. If you run a
changed version as a service for other people, you have to offer them its
source code under the same license.
