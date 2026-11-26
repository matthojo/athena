# Working on Athena

This repository is public: everything committed here is published, history
included. Read `CONTRIBUTING.md` for setup, checks and releases. The rules
below matter most.

## Never commit personal data

- No real person, account or place in code, fixtures, tests, docs,
  screenshots or commit messages: names, email addresses, phone numbers,
  addresses, calendar names, meeting titles, account numbers, site names or
  ids, domains.
- Use made-up data: sample mode's people, `example.com` addresses, UK phone
  numbers from Ofcom's drama range (07700 900xxx), example streets.
- Screenshots come from sample mode only (`localStorage` `athena.mode` set to
  `sample`), never from a signed-in copy.
- Code never names a site: read Netlify's `URL` for the site's own address,
  and use `athena.example.com` in examples.

## Notes don't go in this repository

Build notes, decision logs, the owner's answers, review screenshots and
session briefs are not committed here, and `docs/` is not the place for them.
Put what a reviewer needs in the pull request description. If your brief names
a private notes repository, write longer notes there; if a skill tells you to
write a notes file into this repository, write it to that private repository
instead, or ask.

## One feature, one pull request

Every piece of work reaches `main` as one feature branch and one pull request.

- Work on one branch, `claude/<feature>`, cut from `main`. Groundwork the
  feature needs (shared types, a contract) goes on that branch, never
  straight to `main`.
- When the work is split across sessions, each pushes to its own work
  branch, `claude/<feature>-<part>`, cut from the feature branch, and opens
  no pull request. Whoever coordinates merges each work branch into the
  feature branch once its checks pass, then deletes the work branch.
- Open one pull request, from the feature branch to `main`, as a draft until
  it's ready. Its description carries what changed, the owner's decisions,
  the checks run and any open questions. Fixes after review are pushed to
  the same branch, not opened as new pull requests.

## Only permissive code from elsewhere

Contributors grant the maintainer a broad licence (`CONTRIBUTING.md`,
"Contribution terms") so Athena can be relicensed or hosted. Don't
add a dependency, or copy in code, under the GPL, AGPL, SSPL or a "source
available" licence; `npm run check:licences` checks dependencies. Name the
source and licence of anything copied in the pull request.

## Migrations are append-only

Every copy of Athena applies `netlify/database/migrations/` in order. Never
edit, rename or remove one that's on `main`; add a new one with the next
number, and keep it backwards-compatible. CI fails a pull request that
changes a released migration.

## Design

Before you change how the app looks, read `.claude/design.md`: who it's for,
the type, colour and motion rules, and what to avoid. The tokens are in
`app/src/styles/tokens.css`.

## Docs live in athena-community

Published docs are in the `athena-community` repository, under `docs/`, and
appear at https://athena-community.netlify.app/docs/. That repository is
private: it holds the docs and the Community catalogue (shared themes, skills,
flows and so on). Issues, questions and security reports for Athena and for
Community all come here, so public files never link to the athena-community
repository. This repository keeps only README, SECURITY, CONTRIBUTING and the
other repository files. A change to what Athena does, a label, a route, an MCP
tool or an environment variable needs a docs pull request there. Docs and code
comments describe Athena as it is: no decision log, no "the owner decided", no
dates of decisions.

## Before you push

```sh
npm run typecheck && npm test && npm run build
```

When a change affects what's encrypted, who can read it or what leaves the
site, update the security model in athena-community (`docs/security/`) too.
