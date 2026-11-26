// Run: npx tsx --test netlify/lib/connectors/revoke.test.ts
// Removing an account revokes its sign-in where the provider can: best effort, never logging a token.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { revokeSignIn } from "./revoke";
import type { ConnectorSecrets } from "../../../lib/connectors";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

const seen: Array<{ url: string; init: RequestInit }> = [];
function stub(status = 200, fail = false) {
  seen.length = 0;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    if (fail) throw new TypeError("fetch failed");
    return new Response("", { status });
  }) as typeof fetch;
}
const notShared = async () => false;
const gmail = { provider: "gmail", auth_type: "oauth" as const, oauth: {} };
const secrets: ConnectorSecrets = { ownClient: { client_id: "client-1", client_secret: "shh" }, tokens: { access_token: "access-abc", refresh_token: "refresh-xyz" } };

test("Google: the refresh token is sent to Google's revoke endpoint", async () => {
  stub();
  assert.equal(await revokeSignIn(gmail, secrets, notShared), "revoked");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://oauth2.googleapis.com/revoke");
  assert.equal(String(seen[0].init.body), "token=refresh-xyz");
});

test("an OAuth client another account still uses is left alone: revoking would sign that one out too", async () => {
  stub();
  assert.equal(await revokeSignIn(gmail, secrets, async (family, clientId) => family === "google" && clientId === "client-1"), "skipped");
  assert.equal(seen.length, 0);
});

test("no revoke endpoint, no tokens, or not OAuth: nothing is sent", async () => {
  stub();
  assert.equal(await revokeSignIn({ provider: "outlook-mail", auth_type: "oauth", oauth: {} }, secrets, notShared), "skipped");
  assert.equal(await revokeSignIn(gmail, { ownClient: secrets.ownClient }, notShared), "skipped");
  assert.equal(await revokeSignIn({ provider: "custom", auth_type: "token", oauth: {} }, { token: "t" }, notShared), "skipped");
  assert.equal(seen.length, 0);
});

test("Reddit: the refresh token, with the app's client as basic auth", async () => {
  stub();
  assert.equal(await revokeSignIn({ provider: "reddit", auth_type: "oauth", oauth: {} }, secrets, notShared), "revoked");
  assert.equal(seen[0].url, "https://www.reddit.com/api/v1/revoke_token");
  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("client-1:shh").toString("base64")}`);
  assert.match(String(seen[0].init.body), /token=refresh-xyz&token_type_hint=refresh_token/);
});

test("a refusal or an unreachable provider never throws, and no token reaches the log", async () => {
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  stub(400);
  assert.equal(await revokeSignIn(gmail, secrets, notShared), "refused");
  stub(200, true);
  assert.equal(await revokeSignIn(gmail, secrets, notShared), "failed");
  assert.equal(await revokeSignIn(gmail, secrets, async () => { throw new Error("database down"); }), "failed");
  assert.equal(logged.length, 3);
  for (const line of logged) assert.doesNotMatch(line, /refresh-xyz|access-abc|shh/);
});
