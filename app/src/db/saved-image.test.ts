/**
 * A saved item's picture is fetched with this device's key only from Athena's own API; any other address is
 * shown as it is (a sample's file) or not at all, and never gets the key.
 * Run: npx tsx --test app/src/db/saved-image.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>([["athena.token", "athk_" + "a".repeat(43)]]);
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).caches = { open: async () => ({ match: async () => undefined, put: async () => undefined, delete: async () => true }) };

let calls: Array<{ url: string; auth: string | null }> = [];
(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  calls.push({ url, auth: new Headers(init.headers).get("Authorization") });
  return new Response(new Blob(["x"], { type: "image/webp" }));
};

const { savedImageUrl, isOwnApiPath } = await import("./saved");

beforeEach(() => {
  calls = [];
});

test("the item's own image comes from the API with the key", async () => {
  const url = await savedImageUrl({ id: "s1", image_url: "/api/saved/s1/image" }, "sm");
  assert.match(url ?? "", /^blob:/);
  assert.deepEqual(calls, [{ url: "/api/saved/s1/image?size=sm", auth: `Bearer ${store.get("athena.token")}` }]);
});

test("any other address never gets the key", async () => {
  for (const image_url of ["https://evil.example/pixel.png", "//evil.example/pixel.png", "/sample/saved/canal.webp", "blob:https://athena.example/1"]) {
    const url = await savedImageUrl({ id: `x-${image_url}`, image_url }, "lg");
    assert.equal(url, image_url, "shown as it is, as an <img> would");
  }
  assert.equal(calls.length, 0);
});

test("only a path under /api/ counts as Athena's own", () => {
  assert.equal(isOwnApiPath("/api/saved/s1/image"), true);
  for (const u of ["https://athena.example/api/saved/s1/image", "//evil.example/api/", "/apix/1", "api/saved/1", "/api/\\evil.example"]) assert.equal(isOwnApiPath(u), false, u);
});
