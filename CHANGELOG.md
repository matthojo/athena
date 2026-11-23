# Changelog

Each release's section becomes its notes on GitHub. Merging a new version
into `main` publishes it (`.github/workflows/release.yml`).

## 1.2.0

To-dos with a description, steps, links and a priority.

- Open a to-do and it's a page of its own. Under the title, tap the date,
  person, priority, area or where to change it; the date opens a calendar.
  The description takes Markdown and @ links to people, notes and anything
  else in Athena.
- Steps are a checklist inside a to-do. Return starts the next step, a pasted
  list adds a step for each line, and you can drag a step or press Alt+↑/↓
  to move it. When every step is ticked, Athena offers to mark the to-do
  done.
- Paste an address and the link takes the page's title, or search Athena to
  link a person, note or saved item. Links to things in Athena show in the
  graph.
- Priority is none, low, medium or high. Of the to-dos due on the same day,
  higher priority ones come first. Each row shows its priority, how many
  steps are done and whether it has links or a description.
- Quick add reads a date at the end of the line and a priority anywhere, so
  "Renew the passport by Friday !high" is due Friday and high priority. It
  shows what it found before adding, and Keep as typed adds the line as you
  wrote it.
- Ask, Team assistants and flows can give a to-do a description, steps,
  links and a priority, and tick or change a single step. Collections add
  steps only when the source lists the parts of one task. Each action item
  from a meeting is still its own to-do.
- Deleting a to-do for good now also removes its links in the graph.

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
- Team assistants run flows. Athena turns each assistant's triggers into
  flows it runs on the first reminders pass after you update, and its runs
  and cards look as before. Let an assistant run one of your flows and it can
  add steps that work something out, like looking online for a better price.
  Pausing an assistant stops every flow it runs. If a run fails before doing
  anything, Athena tries it once more.
- Share an assistant as a file, and import one someone shared. Athena takes
  out links into your Athena and flags anything that looks like your own
  people, addresses or numbers. The download waits until you edit each one
  out or mark it fine. An imported assistant joins paused and asks before
  every change until you tick what it may do on its own.
- Work sync reads GitHub replies it used to reject, including a search with
  no results. When it can't read one, the error names the reply's fields
  but not their values.

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
