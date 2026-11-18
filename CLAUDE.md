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

## Migrations are append-only

Every copy of Athena applies `netlify/database/migrations/` in order. Never
edit, rename or remove one that's on `main`; add a new one with the next
number, and keep it backwards-compatible. CI fails a pull request that
changes a released migration.

## Before you push

```sh
npm run typecheck && npm test && npm run build
```

When a change affects what's encrypted, who can read it or what leaves the
site, update `SECURITY.md` too.
