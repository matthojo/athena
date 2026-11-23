# Contributing to Athena

Thanks for helping. Bug reports, ideas, docs and code are all welcome.

- **A question or an idea:** [Discussions](https://github.com/matthojo/athena/discussions).
- **A bug:** an [issue](https://github.com/matthojo/athena/issues/new/choose).
- **A security problem:** GitHub's **Report a vulnerability** button, never
  an issue ([SECURITY.md](SECURITY.md)).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
[GOVERNANCE.md](GOVERNANCE.md) says how decisions are made.

## Before you write code

1. **Agree the idea first.** For anything bigger than a small fix, open an
   issue or a discussion, or comment on an existing one, and wait for a
   yes. It saves you building something that doesn't fit.
2. **Read the [Contributor Assignment Agreement](CONTRIBUTOR_AGREEMENT.md).**
   Every contribution needs it (see [below](#the-contributor-agreement)).
3. **Look for `good first issue`** if you'd like somewhere to start.

## Getting set up

```sh
npm install
npm run dev:app        # the app on http://localhost:5173; choose "Continue with sample data"
```

`netlify dev` runs the functions and MCP server too, with a local database of
its own. The README's "Try it locally" section has the details.

## Making the change

- Fork the repository and work on a branch of your fork.
- Keep a pull request to one change. Two unrelated fixes are two pull
  requests.
- Add or update tests next to the code (`*.test.ts`).
- Write commit messages that say what changed and why, in the imperative:
  "Show the sleep score on Days", not "Fixed stuff".
- If you used an AI assistant, that's fine. Read and test everything it
  wrote: you're answerable for it as your own work.

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run build
cd extension && npm test
```

Files named `*.db.test.ts` skip themselves unless `ATHENA_TEST_DB_URL` points
at a Postgres database with the migrations in `netlify/database/migrations/`
applied; `npm run test:db` runs them. CI runs the rest on every pull request,
along with checks of its own: that no released migration changed, that no
secret slipped in, that every dependency's licence is allowed, and that
everyone who wrote commits has agreed to the contributor agreement.

Open the pull request against `main` and fill in the template. Mark it as a
draft while you're still working on it.

## Rules that keep every copy working

**Migrations are append-only.** Every copy of Athena applies
`netlify/database/migrations/` in order, and Netlify refuses to deploy when a
migration that has already run was edited or removed.

- Never edit, rename or delete a migration that's on `main`. To change the
  schema again, add a new migration.
- Name it with the next number: `00NN_short-name/migration.sql`. Check `main`
  for the highest number just before merging, since two branches can pick the
  same one.
- Keep it backwards-compatible. People skip releases, so a copy may apply
  several migrations at once, and Netlify applies them before the new code
  goes live.

**No real data, anywhere.** This repository is public. Code, fixtures, tests,
docs, screenshots and commit messages use made-up people and places only:
`example.com` addresses, UK phone numbers from Ofcom's drama range
(07700 900000 to 07700 900999), and example streets. Screenshots come from
sample mode. Nothing names a real site: where code needs the site's own
address it reads Netlify's `URL`, and examples use `athena.example.com`.

**Keep SECURITY.md true.** If a change affects what's encrypted, who can read
it, or what leaves the site, update `SECURITY.md` in the same pull request.

**Words people read** (app text, notes Athena writes, docs) follow
`lib/writing-style.ts`: plain and specific, with no filler.

**Only permissive code from elsewhere.** A new dependency, or code copied
from another project, must be under a licence that lets Athena be relicensed:
MIT, BSD, Apache-2.0, ISC or similar. LGPL and MPL are fine for a dependency
used unchanged. Nothing under the GPL, AGPL, SSPL or a "source available"
licence. `npm run check:licences` checks dependencies; name the source and
licence of anything you copy in the pull request.

## The contributor agreement

Athena is licensed under the GNU AGPL v3.0 or later, and every release stays
available under it. Its maintainer may also offer Athena as a hosted service
or under other licences, which needs the maintainer to hold the copyright in
all of it. So before a contribution is merged, its author assigns the
copyright to the maintainer, under the
[Contributor Assignment Agreement](CONTRIBUTOR_AGREEMENT.md), and gets a
licence back to do anything they like with their own work.

The first time you open a pull request, the **Contributor agreement** check
asks you to agree by posting a comment. You only do it once. If you're
contributing for your employer, write to the address in the agreement first.

## Releasing (maintainers)

1. In a pull request, bump `version` in `package.json` (`npm version X.Y.Z
   --no-git-tag-version` also updates `package-lock.json`), and add a
   `## X.Y.Z` section at the top of `CHANGELOG.md`.
2. Merge it. `.github/workflows/release.yml` tags `vX.Y.Z` and publishes the
   release with that section as its notes.
3. Within a week, every copy's **Update Athena** workflow opens a pull request
   for it.
