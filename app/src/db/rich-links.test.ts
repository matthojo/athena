// loadPreview end to end on a stand-in browser: Cache Storage, fetch and the connection are stubs, so the cache rules
// run as they do in the app (this device first, the server after a day, pictures kept, offline from the copy here).
// Run: npx tsx --test app/src/db/rich-links.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LinkPreview } from "../../../lib/link-previews";

// ----- a stand-in browser -----
const store = new Map<string, string>([["athena.token", "t0ken"]]);
(globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
let onLine = true;
Object.defineProperty(globalThis, "navigator", { value: { get onLine() { return onLine; }, userAgent: "Mozilla/5.0 (Windows NT 10.0)" }, configurable: true });
const kept = new Map<string, Response>();
(globalThis as Record<string, unknown>).caches = {
  open: async () => ({
    match: async (k: string) => kept.get(k)?.clone(),
    put: async (k: string, r: Response) => void kept.set(k, r.clone()),
    delete: async (k: string) => kept.delete(k),
  }),
};
let made = 0;
URL.createObjectURL = () => `blob:test/${++made}`;
URL.revokeObjectURL = () => undefined;

let server: LinkPreview | "down" = "down";
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  asked.push(url);
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer t0ken", "the token goes with every request");
  if (server === "down") throw new TypeError("Failed to fetch");
  if (url.startsWith("/api/link-preview?")) return new Response(JSON.stringify(server), { headers: { "Content-Type": "application/json" } });
  if (url.startsWith("/api/link-preview/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp" } });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const { loadPreview } = await import("./rich-links");

const PAGE = "https://example.com/walk";
const DAY = 86_400_000;
function preview(v: string, over: Partial<LinkPreview> = {}): LinkPreview {
  return {
    id: "p1",
    url: PAGE,
    status: "ok",
    title: `A walk (${v})`,
    summary: null,
    site_name: "example.com",
    author: null,
    kind: null,
    facts: null,
    image_url: `/api/link-preview/p1/image?v=${v}`,
    image_w: 1200,
    image_h: 630,
    image_tone: "#334455",
    shape: "wide",
    favicon_url: null,
    fetched_at: v === "a" ? "2026-11-01T00:00:00.000Z" : "2026-12-02T00:00:00.000Z",
    embed: null,
    ...over,
  };
}
const jsonKey = `/link-preview-json/${encodeURIComponent(PAGE)}`;
const age = async (ms: number) => {
  const s = (await kept.get(jsonKey)!.clone().json()) as { preview: LinkPreview; checked_at: number };
  kept.set(jsonKey, new Response(JSON.stringify({ ...s, checked_at: s.checked_at - ms })));
};

test("first time: from the server, under the normalised address, with the picture kept on the device", async () => {
  server = preview("a");
  const p = await loadPreview("http://www.example.com/walk/?utm_source=x#top".replace("www.", ""));
  assert.equal(p?.title, "A walk (a)");
  assert.match(p!.image_url!, /^blob:/, "an object URL an <img> can show without the token");
  assert.equal(p!.favicon_url, null);
  assert.ok(asked.some((u) => u === `/api/link-preview?url=${encodeURIComponent(PAGE)}`), "asked under the normalised address");
  assert.ok(kept.has(jsonKey), "the preview is kept");
  assert.ok(kept.has("/link-preview-cache/p1/image/a"), "the picture is kept");
});

test("again within a day: from this device, no request", async () => {
  asked.length = 0;
  const p = await loadPreview(PAGE);
  assert.equal(p?.title, "A walk (a)");
  assert.deepEqual(asked, []);
});

test("offline: from this device, however old, picture included", async () => {
  await age(40 * DAY);
  onLine = false;
  asked.length = 0;
  const p = await loadPreview(PAGE);
  assert.equal(p?.title, "A walk (a)");
  assert.match(p!.image_url!, /^blob:/);
  assert.deepEqual(asked, []);
  assert.equal(await loadPreview("https://example.com/never-seen"), null, "nothing here and offline: nothing");
  onLine = true;
});

test("after a day: the server is asked, and an unchanged copy is kept", async () => {
  asked.length = 0;
  const p = await loadPreview(PAGE);
  assert.equal(p?.title, "A walk (a)");
  assert.equal(asked.filter((u) => u.startsWith("/api/link-preview?")).length, 1);
  asked.length = 0;
  await loadPreview(PAGE);
  assert.deepEqual(asked, [], "checked: not asked again for a day");
});

test("after a day with the server down: the copy here", async () => {
  await age(2 * DAY);
  server = "down";
  const p = await loadPreview(PAGE);
  assert.equal(p?.title, "A walk (a)");
});

test("the server's newer copy replaces this one, and the old picture goes", async () => {
  server = preview("b");
  const p = await loadPreview(PAGE);
  assert.equal(p?.title, "A walk (b)");
  assert.ok(kept.has("/link-preview-cache/p1/image/b"));
  assert.ok(!kept.has("/link-preview-cache/p1/image/a"), "the old picture is forgotten");
});

test("Try again always asks; a server failure never replaces a good copy", async () => {
  server = preview("c", { status: "failed", title: null, image_url: null, fetched_at: null });
  asked.length = 0;
  const p = await loadPreview(PAGE, { refresh: true });
  assert.ok(asked.some((u) => u.includes("refresh=1")));
  assert.equal(p?.title, "A walk (b)");
  assert.equal(p?.status, "ok");
});

test("an address that isn't a web address is null, with no request", async () => {
  asked.length = 0;
  assert.equal(await loadPreview("athena://person/x"), null);
  assert.equal(await loadPreview("not a link"), null);
  assert.deepEqual(asked, []);
});

test("maps never get a player, even from a copy kept before the rule", async () => {
  server = preview("m", { url: "https://www.google.com/maps/@51.5,-0.12,15z", embed: { provider: "google-maps", kind: "map", embedUrl: "https://www.google.com/maps?q=51.5,-0.12&output=embed", aspect: 4 / 3, openUrl: "x", allow: "fullscreen" } });
  const p = await loadPreview("https://www.google.com/maps/@51.5,-0.12,15z");
  assert.equal(p?.embed?.provider, "google-maps");
  assert.equal(p?.embed?.embedUrl, null, "today's rules, not the kept answer");
});
