<p align="center">
  <img src=".github/readme/logo.png" width="112" height="112" alt="">
</p>

<h1 align="center">Athena</h1>

<p align="center">
  A personal second brain that you host yourself, on your own Netlify site.
</p>

<p align="center">
  <a href="https://matthojo.github.io/athena/"><strong>Website and docs</strong></a>
</p>

<p align="center">
  <a href="https://app.netlify.com/start/deploy?repository=https://github.com/matthojo/athena"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify" height="32"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2c6be7" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/runs%20on-Netlify-2c6be7" alt="Runs on Netlify">
  <img src="https://img.shields.io/badge/node-24-2c6be7" alt="Node 24">
</p>

https://github.com/user-attachments/assets/79f9c13a-f346-4bd5-8ab0-4c5cd8cc7b23


Athena keeps your notes, people, to-dos and days in one Postgres database on
a Netlify site that you own. It collects from the accounts you connect, such
as Gmail, Calendar, Slack and Linear, and Claude answers questions about all
of it, with sources. You can use it from your phone, your Mac or any
MCP client.

Each copy belongs to one person and runs on their own Netlify account, so
the project never sees your data.

<p align="center">
  <img src=".github/readme/home.webp" alt="Athena's Home page on a desktop: a morning greeting, the Ask box with your assistants beside it, and today's train, flight, car hire and hotel in a row" width="100%">
</p>

<p align="center">
  <img src=".github/readme/days.webp" width="31%" alt="Days on a phone: morning and evening questions, a mood picker, and last night's sleep and steps">
  &nbsp;
  <img src=".github/readme/week.webp" width="31%" alt="Week in review on a phone: time with Tom and Priya, and four days in Lisbon">
  &nbsp;
  <img src=".github/readme/team.webp" width="31%" alt="Team on a phone: Moss checking a gift price, and Dot waiting for your Go">
</p>

<p align="center">
  <img src=".github/readme/flows.webp" width="31%" alt="Flows on a phone: two flows Athena suggests from your habits, and Renewal guard waiting for your Go">
  &nbsp;
  <img src=".github/readme/flow.webp" width="31%" alt="A flow on a phone: Renewal guard starts when something's due to renew, then finds what you paid last year">
  &nbsp;
  <img src=".github/readme/flow-run.webp" width="31%" alt="A run of Renewal guard: £38 is 19% more than last year, so a to-do to decide waits for your Go">
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
- **Flows:** a trigger, then steps. "When a renewal email comes in, find
  what I paid last year, and if it's gone up, add a to-do to decide." A flow
  starts on a schedule, when something arrives, before an event or a date,
  or when you tap Run now. Its steps look things up, add to Athena, ask you,
  wait or tell you, and a check can send it down one of two paths. Say
  "whenever…" in Ask, describe one in a sentence under Flows → New, or take
  one Athena suggests from your habits. Adding a reminder, a to-do or a line
  on a list runs on its own; anything else waits for your **Go**, and Athena
  never sends a draft.
- **Team:** assistants you set up, each running its own flows on a schedule
  or when something arrives (a new Linear issue, a saved link). Let an
  assistant run one of your flows and it can add steps that work something
  out, like looking online for a better price, then tell you what it found
  in its own words. A change you haven't allowed waits for your **Go**. Share
  an assistant as a file anyone can add to their own Athena, or add one
  someone shared: it joins paused, and asks before every change until you
  tick what it may do on its own.
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
If you'd rather pay the AI companies yourself, see
[Use your own keys](#use-your-own-keys).

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
- **Your own AI and notification keys:** see
  [Use your own keys](#use-your-own-keys).
- **Claude:** see [Use it from Claude](#use-it-from-claude).

## Use your own keys

Athena works without any of these. Each one hands a part that Netlify or
Athena would otherwise look after to a key you hold yourself.

**AI providers.** Claude, and any other model you choose, runs through
Netlify AI Gateway by default and is billed in Netlify credits. Set your
own provider key as a secret, and Netlify stops handing out its key for that
provider. Athena then calls the provider directly, and the provider bills
you. It works one provider at a time:

| Provider | Variable | Used for |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Ask, collections, the briefing, flows and assistants |
| Google | `GEMINI_API_KEY` | Dictation and spoken questions, Gemini models, pictures |
| OpenAI | `OPENAI_API_KEY` | OpenAI models, GPT Image pictures |
| Meta | `META_API_KEY` | Llama models |
| OpenRouter | `OPENROUTER_API_KEY` | OpenRouter models |
| TypeSafe | `TYPESAFE_API_KEY` | Jev: quick, cheap checks in collections and Ask |

```sh
netlify env:set ANTHROPIC_API_KEY "<your Anthropic key>" --secret --scope functions
```

Then redeploy production. To leave the gateway entirely, set a key for
every provider you use and turn AI features off under **Team settings → AI
enablement** on Netlify. That switch covers every project on your team.

**Notification keys (VAPID).** Athena makes its own key pair for push
notifications and keeps the private half sealed under `ATHENA_DATA_KEY`. To
hold the pair yourself, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (as a
secret) and, optionally, `VAPID_SUBJECT` (`mailto:you@example.com`). Make a
pair with `npx web-push generate-vapid-keys`. After you redeploy, open
Settings → Notifications on each device to move it to the new key.

The [guide](GUIDE.md#your-own-keys-ai-providers-and-notifications) has each
variable's optional address, what stops working without the gateway, and a
command that sets the VAPID keys without printing them.

## Updating

New versions come out as [releases](https://github.com/matthojo/athena/releases).
Settings → About shows which version you're on, and **Check for updates**
asks GitHub whether there's a newer one.

Your copy updates through a pull request. The **Update Athena** workflow in
your repository checks every Monday, and when there's a new release it opens a
pull request that brings your copy up to it. Netlify builds a deploy preview
of that pull request against a copy of your database, so any new migrations
run there before they reach your live site. Merge it, and Netlify updates your
site.

Set it up once, in your repository on GitHub:

1. **Settings → Actions → General**: under "Workflow permissions", turn on
   **Allow GitHub Actions to create and approve pull requests**.
2. To check straight away: **Actions → Update Athena → Run workflow**.

### Details

- **If a release changes a workflow file,** GitHub's built-in token can't push
  it and the run fails. Add a fine-grained personal access token as a
  repository secret named `ATHENA_UPDATE_TOKEN`, with read and write access to
  Contents, Pull requests and Workflows on your repository.
- **A copy made by the Deploy button has no shared history** with this
  repository, so the update copies the release's files over yours. If you've
  changed Athena's own files, the pull request's diff shows what's replaced.
  A fork or clone shares history, so the release is merged and your changes
  are kept unless they conflict.
- **In a public repository, GitHub pauses scheduled workflows** after 60 days
  without activity. Running it from the Actions tab starts it again.
- **To do it by hand,** run `scripts/update-athena.sh` in a clone of your copy.
  It needs the GitHub CLI to open the pull request; with `ATHENA_PUSH=0` it
  only makes the branch.

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

Every document below is also on the [website](https://matthojo.github.io/athena/),
with search.

- [GUIDE.md](GUIDE.md): Ask, reminders and the briefing, voice, connectors
  and collections, and encryption, in detail
- [ARCHITECTURE.md](ARCHITECTURE.md): how the system fits together, and why
- [SECURITY.md](SECURITY.md): the security model, and how to report a
  vulnerability
- [extension/README.md](extension/README.md): the "Save to Athena" browser
  extension
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, checks, and the rules for
  changes and releases
- [SUPPORT.md](SUPPORT.md): where to ask for help
- [GOVERNANCE.md](GOVERNANCE.md): how decisions are made, and the plans for
  hosting
- [CHANGELOG.md](CHANGELOG.md): what changed in each release

## Contributing

Issues, ideas and pull requests are welcome. Ask questions in
[Discussions](https://github.com/matthojo/athena/discussions), and report
security problems privately, as [SECURITY.md](SECURITY.md) describes, not in
a public issue.

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and the
rules every change follows. In short:

```sh
npm run typecheck && npm test && npm run build
```

By contributing, you accept the
[contribution terms](CONTRIBUTING.md#contribution-terms): you keep your
copyright and grant the maintainer a broad licence, so Athena can also be
offered as a hosted service. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

Athena is free software under the [GNU Affero General Public License
v3.0](LICENSE) or later. You can use, change and share it. If you run a
changed version as a service for other people, you have to offer them its
source code under the same license. Every release stays available under it.

The Athena name and logo aren't covered by the license:
[TRADEMARKS.md](TRADEMARKS.md) says how to use them, and what a fork should
do.
