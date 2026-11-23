# Governance

Athena is run by one maintainer, the owner of `github.com/matthojo/athena`,
who decides what goes in, what each release contains, and where the project
goes. That may change as the community grows. If it does, this file will say
how.

## How decisions are made

- **Small fixes** (a bug, a typo, a test) are reviewed and merged by the
  maintainer.
- **Features and larger changes** start as an issue or a discussion, so the
  idea can be agreed before anyone spends time building it. A pull request
  that arrives without one may be declined however good it is, if it doesn't
  fit the project.
- **What fits:** Athena is a second brain for one person, on a Netlify
  site they own, with their content encrypted at rest and never seen by
  the project. A change that weakens that, such as sending data somewhere
  new, won't be merged however it's offered.

When the answer is no, the maintainer says why.

## Money and hosting

Athena is free software, and the self-hosted version will stay that way:
every release is published here under the GNU AGPL v3.0 or later, and stays
available under it.

The maintainer may also offer Athena as a paid, hosted service, or license
it to others on other terms. To keep that possible, contributors grant
the maintainer a broad licence to their work
([CONTRIBUTING.md](CONTRIBUTING.md#contribution-terms)), and Athena only depends on permissively licensed packages
(`scripts/check-licences.ts`). A hosted service may have parts that only it
needs, such as accounts and billing. Features that make Athena better for
the person running their own copy belong in this repository.

## The name and logo

The Athena name and logo mark the maintainer's releases.
[TRADEMARKS.md](TRADEMARKS.md) says how you can use them, including in a
fork.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
