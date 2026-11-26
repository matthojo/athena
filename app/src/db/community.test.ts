// Community's app contract (app/src/db/community.ts): the #/add addresses, and the calls' routes.
// Run: npx tsx --test app/src/db/community.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADD_ROUTE, addHash, checkCatalogue, checkUpdates, COMMUNITY_ROUTE, fetchCatalogue, isNewerFormat, parseAddHash } from "./community";

test("the routes", () => {
  assert.equal(ADD_ROUTE, "#/add");
  assert.equal(COMMUNITY_ROUTE, "#/community");
});

test("#/add addresses for a listing and a link go there and back", () => {
  const catalogue = addHash({ catalogue: "0123456789abcdef" });
  assert.equal(catalogue, "#/add?catalogue=0123456789abcdef");
  assert.deepEqual(parseAddHash(catalogue), { catalogue: "0123456789abcdef" });
  const link = addHash({ link: "https://github.com/example/athena-items/tree/main/flows/renewals?x=1&y=2" });
  assert.equal(link, "#/add?link=https%3A%2F%2Fgithub.com%2Fexample%2Fathena-items%2Ftree%2Fmain%2Fflows%2Frenewals%3Fx%3D1%26y%3D2");
  assert.deepEqual(parseAddHash(link), { link: "https://github.com/example/athena-items/tree/main/flows/renewals?x=1&y=2" });
});

test("#/add alone is files; a listing wins over a link; other addresses aren't #/add", () => {
  assert.deepEqual(parseAddHash("#/add"), { files: [] });
  assert.deepEqual(parseAddHash("#/add/"), { files: [] });
  assert.deepEqual(parseAddHash("#/add?catalogue=%20"), { files: [] });
  assert.deepEqual(parseAddHash("#/add?link=https%3A%2F%2Fgithub.com%2Fx&catalogue=0123456789abcdef"), { catalogue: "0123456789abcdef" });
  assert.equal(parseAddHash("#/community"), null);
  assert.equal(parseAddHash("#/added"), null);
  assert.equal(parseAddHash("#/flows/add"), null);
});

test("a file made for a newer Athena is told apart from any other failure", () => {
  assert.equal(isNewerFormat({ status: 426 }), true);
  assert.equal(isNewerFormat({ newer: true }), true);
  assert.equal(isNewerFormat({ status: 400 }), false);
  assert.equal(isNewerFormat(new Error("x")), false);
  assert.equal(isNewerFormat(null), false);
});

test("fetchCatalogue and checkUpdates call their routes", async () => {
  const seen: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const was = { fetch: g.fetch, localStorage: g.localStorage };
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  g.fetch = async (url: string) => {
    seen.push(String(url));
    const body = String(url).endsWith("/updates") ? { updates: [] } : { configured: false, on: false, generated_at: null, fetched_at: null, items: [], added: [], error: null };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    assert.equal((await fetchCatalogue()).configured, false);
    assert.deepEqual(await checkUpdates(), []);
    assert.deepEqual(
      seen.map((u) => u.replace(/^.*\/api/, "/api")),
      ["/api/community", "/api/community/updates"]
    );
  } finally {
    g.fetch = was.fetch;
    g.localStorage = was.localStorage;
  }
});

test("checkCatalogue posts to the check route", async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const g = globalThis as Record<string, unknown>;
  const was = { fetch: g.fetch, localStorage: g.localStorage };
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  g.fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url).replace(/^.*\/api/, "/api"), method: init?.method });
    return new Response(JSON.stringify({ configured: true, on: true, generated_at: null, fetched_at: "2026-11-26T09:14:00Z", items: [], added: [], error: null, checked: "recent" }), { status: 200 });
  };
  try {
    assert.equal((await checkCatalogue()).checked, "recent");
    assert.deepEqual(seen, [{ url: "/api/community/check", method: "POST" }]);
  } finally {
    g.fetch = was.fetch;
    g.localStorage = was.localStorage;
  }
});
