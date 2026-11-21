# Changelog

Each release's section becomes its notes on GitHub. Merging a new version
into `main` publishes it (`.github/workflows/release.yml`).

## 1.1.0

Flows, and Team assistants you can share.

- Flows: a trigger, then steps. A flow starts on a schedule, when something
  arrives, before an event or a date, or when you tap Run now. Its steps look
  things up, add to Athena, ask you, wait or tell you, and a check can send it
  down one of two paths. Make one under Flows → New, by saying "whenever…" in
  Ask, or take one Athena suggests from your habits.
- Adding a reminder, a to-do or a line on a list runs on its own. Anything
  else, including drafting an email or a message, waits for your Go, and
  Athena never sends a draft. A flow's changes show in What Ask did as
  "Flow: <name>", and Settings → Notifications has a switch for Flows.
- Team assistants run flows. Each assistant's triggers become flows it runs,
  moved over on the first reminders pass after you update, and its runs and
  cards look as before. Let an assistant run one of your flows and it can add
  steps that work something out. Pausing an assistant stops every flow it
  runs, and a run that failed before anything happened is tried once more.
- Share an assistant as a file, and import one someone shared. Links into
  your Athena are taken out, and anything that looks like your own people,
  addresses or numbers is flagged. The download waits until you edit each
  one out or mark it fine. An imported assistant joins paused and asks
  before every change until you tick what it may do on its own.
- Work sync reads more of the shapes GitHub's replies come in. When it can't
  read one, the error names the reply's fields, never their values.
- Four new migrations (0080 to 0083) add the tables and columns Flows needs.

## 1.0.0

The first public release.

- Notes, people, to-dos, projects, places, events, reminders, goals, habits,
  saved links, recipes, and things to watch and read, linked to each other.
- Ask: answers from your notes and connected accounts with checked sources,
  and instructions it carries out with Undo.
- Days, collections from Gmail, Calendar, Outlook, Granola, Linear, Slack,
  GitHub, Notion and any MCP server, Team assistants, the morning briefing,
  push reminders, voice and Talk.
- Encryption at rest, with health, location, money and home figures sealed
  apart (`SECURITY.md`).
- A Deploy to Netlify button, and updates through a weekly pull request in
  your own copy (README, "Updating").
- Settings → About shows your version, checks for a newer one, and lists
  the details to copy into a bug report.
