# Changelog

Each release's section becomes its notes on GitHub. Merging a new version
into `main` publishes it (`.github/workflows/release.yml`).

## 1.3.0

Community, themes, and documentation on a site of its own.

- Community is a directory of assistants, skills, flows, check-in questions,
  templates and themes that other people have shared, each read by a
  maintainer before it's listed. Open it from the Library, read everything an
  item would add and what it can reach, then choose Add. Nothing runs until
  you switch it on, and an update waits until you take it. While Check the
  Community catalogue is on (Settings → Ask), Athena reads the list at most
  once a day. `ATHENA_CATALOGUE_URL` points Athena at another catalogue, or at
  none.
- Share a flow, a set of check-in questions, a note template or a theme as a
  file, as you can an assistant, and send it to Community from a public GitHub
  repository of yours.
- Themes: Settings → Appearance has built-in themes, and you can make your
  own, with colours for light and dark, corners, spacing and a text size. Your
  own font and text size stay as you set them, whatever the theme.
- Check-in questions can come from Community, and written answers go to that
  day's journal. A day's journal can start from a note template.
- Health has a Wellness tab: your check-in answers over time, with mood,
  energy, rest and stress as a coloured dot for each day, week or month.
- A Calendar collection syncs your upcoming events every hour without AI, so
  a busy calendar doesn't spend credits. It takes over the events a Meetings
  collection synced.
- Inbox: a card groups only finds that are the same, and Add to calendar
  takes the whole card. You can ignore emails like one in front of you, from
  that address or its whole domain, and the rule goes into that account's
  email rules.
- Home keeps to what the next few hours need: the greeting, Ask, one "Waiting
  for you" card, the Inbox and what's due, a meeting to prepare for, the
  briefing and your to-dos.
- Ask: a request, such as "Remind me tomorrow at 8 to call Sam", starts
  without a search of your notes; a question still gets one. Under a reply
  that did something, Athena leaves out the "Couldn't search" line and the list
  of past conversations, since neither went into it.
- A run opens only the links you typed or approved, or a saved item's own
  link. A tracker link the model chose waits for your approval.
- A Raycast extension, in its own repository
  ([athena-raycast](https://github.com/matthojo/athena-raycast)), adds,
  searches and ticks things off from the keyboard. Saves from it are marked as
  coming from Raycast.
- The documentation is on the Community site, at
  https://athena-community.netlify.app/docs/, rewritten and checked against
  the code: getting started, a guide to every part of Athena, running your
  copy, reference, architecture and the security model. README and SECURITY.md
  are shorter and link there.
- Claude routines for collection are removed, with the agent specs and the
  `register-collection-agent` skill. Collections inside Athena do this job. If
  you registered one as a routine on claude.ai, turn it off there.

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
