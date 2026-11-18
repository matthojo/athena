/**
 * M2: the browser signs in with a per-device full key; the master token is
 * used once to make it and is never stored.
 * Run: npx tsx --test app/src/db/sign-in.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

interface Call {
  url: string;
  method: string;
  editor: string | null;
  auth: string | null;
  body: any;
}
let calls: Call[] = [];
let respond: (c: Call) => Response = () => new Response("{}", { status: 200 });
(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  const c: Call = { url, method: init.method ?? "GET", editor: new Headers(init.headers).get("X-Athena-Editor"), auth: new Headers(init.headers).get("Authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(c);
  return respond(c);
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const { signIn, swapMasterForKey, requestWithMaster, removeOwnKey, deviceName, getToken, request, updateNote, createNote, saveTimeZone, makeApiKey } = await import("./api");

const MASTER = "master-token-0123456789";
const KEY = "athk_" + "a".repeat(43);
const everythingStored = () => [...store.values()].join("\n");

beforeEach(() => {
  store.clear();
  calls = [];
  respond = () => json({ key: { id: "1", label: "x", scope: "full" }, token: KEY }, 201);
});

test("a pasted master token makes a full key for this device, and only the key is kept", async () => {
  assert.deepEqual(await signIn(`  ${MASTER} `), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/api-keys");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].auth, `Bearer ${MASTER}`);
  assert.equal(calls[0].body.scope, "full");
  assert.match(calls[0].body.label, /^Athena app/);
  assert.equal(getToken(), KEY);
  assert.ok(!everythingStored().includes(MASTER), "the master token is not in storage");
});

test("later requests carry the device key", async () => {
  await signIn(MASTER);
  respond = () => json({ ok: true });
  await request("/health");
  assert.equal(calls.at(-1)!.auth, `Bearer ${KEY}`);
});

test("a pasted full key is stored as it is, with no request", async () => {
  assert.deepEqual(await signIn(KEY), { ok: true });
  assert.equal(calls.length, 0);
  assert.equal(getToken(), KEY);
});

test("a capture key is turned away and not stored", async () => {
  const r = await signIn("athc_" + "b".repeat(43));
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(getToken(), null);
});

test("a wrong token is refused and nothing is stored", async () => {
  respond = () => json({ error: "Unauthorized" }, 401);
  assert.deepEqual(await signIn(MASTER), { ok: false, reason: "refused" });
  assert.equal(store.size, 0);
});

test("offline: nothing is stored, least of all the master token", async () => {
  respond = () => {
    throw new TypeError("Failed to fetch");
  };
  const r = await signIn(MASTER);
  assert.equal(r.ok === false && r.reason, "unreachable");
  assert.equal(store.size, 0);
});

test("a reply that isn't a full key is not stored", async () => {
  respond = () => json({ token: MASTER }, 201);
  const r = await signIn(MASTER);
  assert.equal(r.ok, false);
  assert.equal(store.size, 0);
});

test("an install still holding the master token swaps it for a key on launch", async () => {
  store.set("athena.token", MASTER);
  assert.equal(await swapMasterForKey(), true);
  assert.equal(calls[0].auth, `Bearer ${MASTER}`);
  assert.equal(getToken(), KEY);
  assert.ok(!everythingStored().includes(MASTER));
  // Already a key: nothing more to do.
  calls = [];
  assert.equal(await swapMasterForKey(), false);
  assert.equal(calls.length, 0);
});

test("the swap waits for a connection, and leaves sample mode and signed-out installs alone", async () => {
  store.set("athena.token", MASTER);
  respond = () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await swapMasterForKey(), false);
  assert.equal(getToken(), MASTER, "kept, to try again next launch");

  store.clear();
  assert.equal(await swapMasterForKey(), false);
  store.set("athena.mode", "sample");
  store.set("athena.token", MASTER);
  calls = [];
  assert.equal(await swapMasterForKey(), false);
  assert.equal(calls.length, 0);
});

test("requestWithMaster sends one call with the typed token and stores nothing", async () => {
  store.set("athena.token", KEY);
  respond = () => json({ keys: [] });
  assert.deepEqual(await requestWithMaster(MASTER, "/api-keys"), { keys: [] });
  assert.equal(calls[0].auth, `Bearer ${MASTER}`);
  assert.equal(getToken(), KEY);
  assert.ok(!everythingStored().includes(MASTER));
});

test("requestWithMaster surfaces master_required", async () => {
  respond = () => json({ error: "master_required" }, 403);
  await assert.rejects(requestWithMaster(KEY, "/api-keys"), (e: any) => e.status === 403 && e.message === "master_required");
});

test("deviceName names the browser and device", () => {
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Athena app, Safari on iPhone");
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"), "Athena app, Chrome on Mac");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"), "Athena app, Chrome on Android");
  assert.equal(deviceName(""), "Athena app");
  assert.ok(deviceName("x".repeat(500)).length <= 60);
});

test("sign out removes this device's own key on the server, with that key", async () => {
  store.set("athena.token", KEY);
  respond = () => new Response(null, { status: 204 });
  assert.equal(await removeOwnKey(), true);
  assert.deepEqual([calls[0].url, calls[0].method, calls[0].auth], ["/api/api-keys/self", "DELETE", `Bearer ${KEY}`]);
});

test("the self-remove call is never made with a master token, a capture key or no key", async () => {
  for (const held of [MASTER, "athc_" + "b".repeat(43), null]) {
    store.clear();
    if (held) store.set("athena.token", held);
    calls = [];
    assert.equal(await removeOwnKey(), false);
    assert.equal(calls.length, 0);
  }
});

// Note versions: the server groups the owner's typing by this header.
test("a note edit from the editor carries X-Athena-Editor: 1; other writes don't", async () => {
  store.set("athena.token", KEY);
  respond = () => json({});
  await updateNote("n1", { body: "typed" }, { editor: true });
  assert.deepEqual([calls[0].url, calls[0].method, calls[0].editor], ["/api/notes/n1", "PATCH", "1"]);
  assert.equal(calls[0].auth, `Bearer ${KEY}`);

  calls = [];
  await updateNote("n1", { body: "not typed" });
  await createNote({ body: "new" });
  await saveTimeZone("Europe/London");
  await makeApiKey("x", "full");
  await request("/saved/s1", { method: "PATCH", body: "{}" });
  assert.equal(calls.length, 5);
  for (const c of calls) assert.equal(c.editor, null, `${c.method} ${c.url}`);
});
