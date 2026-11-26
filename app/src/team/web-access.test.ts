// The app's side of `web`, against fakes of what the server sends
// until lib/team-types.ts has the field. Run: npx tsx --test app/src/team/web-access.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { draftWantsWeb, needsWeb, rememberWebHint, webOn, webPatch } = await import("./web-access");
type A = Parameters<typeof webOn>[0];
type D = Parameters<typeof draftWantsWeb>[0];

beforeEach(() => store.clear());

const fake = (extra: Record<string, unknown>) => ({ id: "a1", name: "Moss", ...extra }) as unknown as A;

test("the switch reads the server's `web`, and is off when it's missing", () => {
  assert.equal(webOn(fake({ web: true })), true);
  assert.equal(webOn(fake({ web: false })), false);
  assert.equal(webOn(fake({})), false);
  // Anything but true is off: a server that sends junk doesn't switch it on.
  assert.equal(webOn(fake({ web: "yes" })), false);
});

test("a draft proposes it only when it says `web: true`", () => {
  assert.equal(draftWantsWeb({ web: true } as unknown as D), true);
  assert.equal(draftWantsWeb({} as unknown as D), false);
});

test("a patch sends `web` as PATCH /api/team/:id takes it", () => {
  assert.equal(JSON.stringify(webPatch(true)), '{"web":true}');
  assert.equal(JSON.stringify(webPatch(false)), '{"web":false}');
});

test("the hint from hiring is kept on the device, and can be dropped", () => {
  assert.equal(needsWeb({ id: "a1" }), false);
  rememberWebHint("a1", true);
  assert.equal(needsWeb({ id: "a1" }), true);
  assert.equal(needsWeb({ id: "a2" }), false);
  rememberWebHint("a1", false);
  assert.equal(needsWeb({ id: "a1" }), false);
});

test("unreadable storage means no hint, not a crash", () => {
  store.set("athena.team.webHint", "{not json");
  assert.equal(needsWeb({ id: "a1" }), false);
  rememberWebHint("a1", true);
  assert.equal(needsWeb({ id: "a1" }), true);
});
