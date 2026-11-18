# Contributing to Athena

Thanks for helping. Issues and pull requests are both welcome. For a security
problem, use GitHub's **Report a vulnerability** button instead of an issue
(see [SECURITY.md](SECURITY.md)).

## Getting set up

```sh
npm install
npm run dev:app        # the app on http://localhost:5173; choose "Continue with sample data"
```

`netlify dev` runs the functions and MCP server too, with a local database of
its own. The README's "Try it locally" section has the details.

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
along with two checks of its own: that no released migration changed, and
that no secret slipped in.

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

## License

Athena is licensed under the GNU AGPL v3.0 or later. By contributing, you
agree that your contribution is licensed the same way.

## Releasing (maintainers)

1. In a pull request, bump `version` in `package.json` (`npm version X.Y.Z
   --no-git-tag-version` also updates `package-lock.json`), and add a
   `## X.Y.Z` section at the top of `CHANGELOG.md`.
2. Merge it. `.github/workflows/release.yml` tags `vX.Y.Z` and publishes the
   release with that section as its notes.
3. Within a week, every copy's **Update Athena** workflow opens a pull request
   for it.
