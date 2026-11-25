// Community settings (lib/community-config.ts): where the catalogue is, the files under it, and the owner's switch.
// The pure helpers only; the switch's load and save are lib/profile.ts's pattern. Nothing needs a database.
// Run: npx tsx --test lib/community-config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogueFileUrl, catalogueUrl, cleanCatalogueUrl, readCommunityCheck, submitPageUrl } from "./community-config";
import { COMMUNITY_SITE } from "./catalogue-types";

test("the catalogue address: https only, trimmed, no trailing slash, query or credentials", () => {
  assert.equal(cleanCatalogueUrl(undefined), "");
  assert.equal(cleanCatalogueUrl("  "), "");
  assert.equal(cleanCatalogueUrl("https://catalogue.example.com/"), "https://catalogue.example.com");
  assert.equal(cleanCatalogueUrl("https://example.com/athena/catalogue//"), "https://example.com/athena/catalogue");
  assert.equal(cleanCatalogueUrl("http://catalogue.example.com"), "");
  assert.equal(cleanCatalogueUrl("http://localhost:8888/"), "http://localhost:8888");
  assert.equal(cleanCatalogueUrl("https://user:pass@catalogue.example.com"), "");
  assert.equal(cleanCatalogueUrl("https://catalogue.example.com/?v=1"), "");
  assert.equal(cleanCatalogueUrl("ftp://catalogue.example.com"), "");
  assert.equal(cleanCatalogueUrl("not a url"), "");
});

test("catalogueUrl is the Community site unless ATHENA_CATALOGUE_URL names another, or none", () => {
  const saved = process.env.ATHENA_CATALOGUE_URL;
  try {
    delete process.env.ATHENA_CATALOGUE_URL;
    assert.equal(catalogueUrl(), COMMUNITY_SITE);
    assert.equal(cleanCatalogueUrl(COMMUNITY_SITE), COMMUNITY_SITE, "the default is a clean https root");
    process.env.ATHENA_CATALOGUE_URL = "  ";
    assert.equal(catalogueUrl(), COMMUNITY_SITE, "set but blank counts as unset");
    process.env.ATHENA_CATALOGUE_URL = "https://catalogue.example.com/";
    assert.equal(catalogueUrl(), "https://catalogue.example.com");
    process.env.ATHENA_CATALOGUE_URL = "off";
    assert.equal(catalogueUrl(), "", "anything that isn't an address means no catalogue");
  } finally {
    if (saved === undefined) delete process.env.ATHENA_CATALOGUE_URL;
    else process.env.ATHENA_CATALOGUE_URL = saved;
  }
});

test("the page for sending an item in is /submit/ at the catalogue's host", () => {
  assert.equal(submitPageUrl("https://catalogue.example.com"), "https://catalogue.example.com/submit/");
  assert.equal(submitPageUrl("https://catalogue.example.com/v1"), "https://catalogue.example.com/submit/");
  assert.equal(submitPageUrl(COMMUNITY_SITE), `${COMMUNITY_SITE}/submit/`);
  assert.equal(submitPageUrl(""), null);
});

test("a file's address stays under the catalogue's root", () => {
  const root = "https://catalogue.example.com/v1";
  assert.equal(catalogueFileUrl(root, "index.json"), "https://catalogue.example.com/v1/index.json");
  assert.equal(catalogueFileUrl(root, "bundles/0123456789abcdef.json"), "https://catalogue.example.com/v1/bundles/0123456789abcdef.json");
  for (const bad of ["", "/index.json", "../index.json", "bundles/../../x.json", "bundles//x.json", "x.json?y=1", "x.json#y", "a\\b.json"]) assert.equal(catalogueFileUrl(root, bad), null, bad);
  assert.equal(catalogueFileUrl("", "index.json"), null);
});

test("the switch is off unless the owner turned it on", () => {
  assert.equal(readCommunityCheck(undefined), false);
  assert.equal(readCommunityCheck(null), false);
  assert.equal(readCommunityCheck({}), false);
  assert.equal(readCommunityCheck({ on: "true" }), false);
  assert.equal(readCommunityCheck({ on: false }), false);
  assert.equal(readCommunityCheck({ on: true }), true);
});
