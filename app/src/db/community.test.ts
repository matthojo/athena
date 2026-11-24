// Community's app contract (app/src/db/community.ts): the #/add addresses, and the calls that aren't built yet.
// Run: npx tsx --test app/src/db/community.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADD_ROUTE, addHash, addItem, checkUpdates, COMMUNITY_ROUTE, fetchCatalogue, parseAddHash, previewAdd } from "./community";

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

test("the calls aren't built yet, and say so", async () => {
  await assert.rejects(previewAdd({ catalogue: "0123456789abcdef" }), /previewAdd: not built yet/);
  await assert.rejects(addItem({} as never, {} as never), /addItem: not built yet/);
});

test("fetchCatalogue and checkUpdates call their routes", async () => {
  const seen: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const was = { fetch: g.fetch, localStorage: g.localStorage };
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  g.fetch = async (url: string) => {
    seen.push(String(url));
    const body = String(url).endsWith("/updates") ? { updates: [] } : { configured: false, on: false, generated_at: null, items: [], added: [], error: null };
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
