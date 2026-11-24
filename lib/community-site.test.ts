// The Community site's addresses (lib/community-site.ts), and what a shared file's based_on may name.
// Made-up ids and hosts only. Run: npx tsx --test lib/community-site.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMUNITY_SITE, listingIdOf, listingLink, listingPageUrl, submitPageUrl } from "./community-site";
import { readHeader } from "./share-kinds";
import { basedOnLink } from "./team-share";

const ID = "k3m9p2q7r4s8t1v6";

test("the site is a plain https address with no trailing slash", () => {
  const u = new URL(COMMUNITY_SITE);
  assert.equal(u.protocol, "https:");
  assert.equal(`${u.origin}`, COMMUNITY_SITE);
});

test("a listing's page and the submit page sit at the catalogue's host", () => {
  assert.equal(listingPageUrl(COMMUNITY_SITE, ID), `${COMMUNITY_SITE}/items/${ID}/`);
  assert.equal(listingPageUrl("https://catalogue.example.com/v1", ID), `https://catalogue.example.com/items/${ID}/`);
  assert.equal(listingPageUrl("", ID), null);
  assert.equal(listingPageUrl(COMMUNITY_SITE, "../admin"), null);
  assert.equal(listingPageUrl(COMMUNITY_SITE, "check-in-weekly"), null);
  assert.equal(submitPageUrl(COMMUNITY_SITE), `${COMMUNITY_SITE}/submit/`);
});

test("based_on: a Community listing on the site itself, cleaned, and nothing else from there", () => {
  const listing = `${COMMUNITY_SITE}/items/${ID}/`;
  assert.equal(listingLink(listing), listing);
  assert.equal(listingLink(`${COMMUNITY_SITE}/items/${ID}`), listing, "the trailing slash is added");
  assert.equal(listingLink(`  ${listing}  `), listing);
  for (const bad of [
    `http://athena-community.netlify.app/items/${ID}/`,
    `https://catalogue.example.com/items/${ID}/`,
    `https://athena-community.netlify.app.example.com/items/${ID}/`,
    `${COMMUNITY_SITE}/items/${ID}/?ref=me`,
    `${COMMUNITY_SITE}/items/${ID}/#top`,
    `${COMMUNITY_SITE}/items/not-an-id/`,
    `${COMMUNITY_SITE}/submit/`,
    `${COMMUNITY_SITE}/items/${ID}/extra`,
    `https://someone@athena-community.netlify.app/items/${ID}/`,
    42,
    null,
  ])
    assert.equal(listingLink(bad), undefined, String(bad));
  assert.equal(listingIdOf(listing), ID);
  assert.equal(listingIdOf("https://github.com/sample-author/athena-items"), null);
  assert.equal(listingIdOf(undefined), null);
});

test("a shared file's header keeps a GitHub link or a Community listing, and drops anything else", () => {
  const listing = `${COMMUNITY_SITE}/items/${ID}/`;
  assert.equal(readHeader({ based_on: listing }).based_on, listing);
  assert.equal(readHeader({ based_on: "https://github.com/sample-author/athena-items/tree/main/flows/bins" }).based_on, "https://github.com/sample-author/athena-items/tree/main/flows/bins");
  assert.equal(readHeader({ based_on: `https://catalogue.example.com/items/${ID}/` }).based_on, undefined);
  assert.equal(basedOnLink(listing), listing);
  assert.equal(basedOnLink("https://example.com/x"), undefined);
});
