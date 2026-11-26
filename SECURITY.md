# Security

Athena is open-source software that you host yourself. It's maintained in
spare time and provided as is, without warranty, under the GNU AGPL v3.0 or
later. Sections 15 and 16 of the [licence](LICENSE) cover warranty and
liability.

## Reporting a problem

If you think you've found a security problem, report it privately with the
**Report a vulnerability** button on this repository's
[Security tab](https://github.com/matthojo/athena/security/advisories/new).
Please don't open a public issue, discussion or pull request about it.

It helps to include:

- what you found, and what someone could do with it
- the steps to see it, ideally in sample mode or on a copy of your own
- the Athena version or commit, from Settings → About

Test only against a copy of Athena that you run yourself, and leave out any
real personal data, yours or anyone else's.

A problem in an item listed on Athena Community, or in the Community site
itself, goes to the
[Community repository](https://github.com/matthojo/athena-community/security)
instead.

## What happens next

The maintainer aims to look at every report and to fix real problems as they
come up. There's no set response time, and no guarantee of a fix. A fix goes
into a new release, and the release notes say what it fixes. Older releases
don't get separate fixes. If you'd like to be named in the release notes, say
so in your report.

## Your own copy

Each copy of Athena belongs to the person who runs it. You choose where it's
hosted, hold its keys and decide when to update. A fix reaches your copy only
when you update it
([Updating](https://athena-community.netlify.app/docs/run/updating/)).

## How Athena is designed

This is a summary of what the design aims to do, not a guarantee:

- What you write is encrypted at rest, under a key that only your production
  functions are given. Your server holds that key, so this isn't end-to-end
  encryption.
- Health, location, money and home figures are sealed apart from the rest and
  opened only when a page asks for them.
- Connected accounts get read-only tools unless you switch on something that
  writes. Account sign-ins are sealed under a second key.
- Athena hasn't had an independent audit, and it doesn't claim to meet any
  compliance standard.

The [security model](https://athena-community.netlify.app/docs/security/)
has the detail: the threat model, what is and isn't encrypted, what leaves
your site, and the known limits.

## Changing what's protected

A pull request that changes what's encrypted, who can read it or what leaves
the site updates the security model too: open a matching pull request on the
[Community repository](https://github.com/matthojo/athena-community), where
the docs live, and link it from yours.
