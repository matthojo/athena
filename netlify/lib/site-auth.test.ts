/**
 * The login gate (netlify/edge-functions/site-auth.ts): sessions are bound to the password, and only a POST from
 * Athena's own pages signs out. Run: npx tsx --test netlify/lib/site-auth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const env = new Map<string, string>([
  ["SITE_PASSWORD", "correct horse battery staple"],
  ["SESSION_SECRET", "2".repeat(64)],
]);
(globalThis as any).Deno = { env: { get: (k: string) => env.get(k) } };

const { default: gate, makeSessionCookie, hasValidSession, CLEAR_SESSION_COOKIE, fromThisSite } = await import("../edge-functions/site-auth");

const SITE = "https://athena.example.com";
const passed = new Response("the app");
const next = { next: async () => passed };
const cookieOf = (setCookie: string) => setCookie.split(";")[0];

async function signIn(): Promise<string> {
  const form = new FormData();
  form.set("password", env.get("SITE_PASSWORD")!);
  const res = await gate(new Request(`${SITE}/login`, { method: "POST", body: form }), next);
  assert.equal(res.status, 303);
  return cookieOf(res.headers.get("Set-Cookie")!);
}

const visit = (cookie: string, path = "/") => gate(new Request(`${SITE}${path}`, { headers: { cookie } }), next);

test("a session opens the site", async () => {
  const cookie = await signIn();
  assert.equal(await visit(cookie), passed);
});

test("changing SITE_PASSWORD signs every session out", async () => {
  const cookie = await signIn();
  env.set("SITE_PASSWORD", "a new password");
  try {
    const res = await visit(cookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/login");
  } finally {
    env.set("SITE_PASSWORD", "correct horse battery staple");
  }
  assert.equal(await visit(cookie), passed, "the old password's session is good again once it's back");
});

test("a session signed over the expiry alone, as before, isn't accepted", async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.get("SESSION_SECRET")!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)))).toString("base64url");
  assert.equal(await hasValidSession(`athena_session=${exp}.${sig}`, env.get("SESSION_SECRET")!, env.get("SITE_PASSWORD")!), false);
});

test("an expired session isn't accepted", async () => {
  const old = cookieOf(await makeSessionCookie(env.get("SESSION_SECRET")!, env.get("SITE_PASSWORD")!, Date.now() - 31 * 86_400_000));
  assert.equal(await hasValidSession(old, env.get("SESSION_SECRET")!, env.get("SITE_PASSWORD")!), false);
});

test("the session cookie is set and cleared with the same attributes", async () => {
  const set = await makeSessionCookie("s", "p");
  const attrs = (c: string) => c.split(";").slice(1).map((a) => a.trim()).filter((a) => !a.startsWith("Max-Age"));
  assert.deepEqual(attrs(CLEAR_SESSION_COOKIE), attrs(set));
  assert.deepEqual(attrs(set).sort(), ["HttpOnly", "Path=/", "SameSite=Strict", "Secure"]);
  assert.match(CLEAR_SESSION_COOKIE, /^athena_session=;.*Max-Age=0$/);
});

for (const headers of [{ "Sec-Fetch-Site": "same-origin" }, { Origin: SITE }] as Record<string, string>[]) {
  test(`POST /logout from Athena's own page signs out (${Object.keys(headers)[0]})`, async () => {
    const cookie = await signIn();
    const res = await gate(new Request(`${SITE}/logout`, { method: "POST", headers: { cookie, ...headers } }), next);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/login");
    assert.equal(res.headers.get("Set-Cookie"), CLEAR_SESSION_COOKIE);
    assert.equal(res.headers.get("Clear-Site-Data"), '"storage", "cache"');
  });
}

test("GET /logout, or another site's POST, signs nothing out", async () => {
  const cookie = await signIn();
  const tries = [
    new Request(`${SITE}/logout`, { headers: { cookie } }),
    new Request(`${SITE}/logout`, { method: "POST", headers: { cookie, "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } }),
    new Request(`${SITE}/logout`, { method: "POST", headers: { cookie, Origin: "https://evil.example" } }),
    new Request(`${SITE}/logout`, { method: "POST", headers: { cookie, Origin: "null" } }),
    new Request(`${SITE}/logout`, { method: "POST", headers: { cookie } }),
  ];
  for (const req of tries) {
    const res = await gate(req, next);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/");
    assert.equal(res.headers.get("Set-Cookie"), null);
    assert.equal(res.headers.get("Clear-Site-Data"), null);
  }
  assert.equal(await visit(cookie), passed, "still signed in");
});

test("fromThisSite prefers Sec-Fetch-Site, then Origin", () => {
  const req = (headers: Record<string, string>) => new Request(`${SITE}/logout`, { method: "POST", headers });
  assert.equal(fromThisSite(req({ "Sec-Fetch-Site": "same-origin", Origin: "https://evil.example" })), true);
  assert.equal(fromThisSite(req({ "Sec-Fetch-Site": "same-site", Origin: SITE })), false);
  assert.equal(fromThisSite(req({ Origin: SITE })), true);
  assert.equal(fromThisSite(req({})), false);
});

test("the login page keeps its own headers", async () => {
  const res = await gate(new Request(`${SITE}/login`), next);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});
