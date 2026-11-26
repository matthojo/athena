// Run: npx tsx --test netlify/lib/connectors/icons.test.ts
// The SSRF guard every owner-typed or server-chosen address goes through (Plex, Jellyfin, Mastodon, logos, art, maps).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHost, isInternalAddress, publicHostNet } from "./icons";

const realLookup = publicHostNet.lookup;
afterEach(() => {
  publicHostNet.lookup = realLookup;
});

test("isInternalAddress: IPv4 loopback, private, link-local, shared, reserved and multicast", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "192.0.0.8", "192.0.2.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(isInternalAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "151.101.1.1", "172.32.0.1", "100.128.0.1", "192.0.1.1"]) assert.equal(isInternalAddress(ip), false, ip);
});

test("isInternalAddress: IPv6, including every form that carries an internal IPv4 address", () => {
  for (const ip of [
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // what the URL parser makes of [::ffff:127.0.0.1]
    "::FFFF:A9FE:A9FE", // 169.254.169.254
    "::ffff:10.0.0.1",
    "::7f00:1", // IPv4-compatible
    "::127.0.0.1",
    "::ffff:0:7f00:1", // SIIT
    "64:ff9b::7f00:1", // NAT64 to loopback
    "64:ff9b:1::1",
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "2002:c0a8:101::", // 6to4 of 192.168.1.1
    "2001:0:4136:e378:8000:63bf:80ff:fffe", // Teredo, client 127.0.0.1
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "not-an-ip",
    "1:2:3",
  ]) {
    assert.equal(isInternalAddress(ip), true, ip);
  }
  for (const ip of ["2606:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) {
    assert.equal(isInternalAddress(ip), false, ip);
  }
});

test("assertPublicHost: literal addresses in any spelling the URL parser accepts are refused", async () => {
  for (const u of [
    "https://127.0.0.1/",
    "https://2130706433/", // decimal
    "https://0x7f.1/", // hex
    "https://0177.0.0.1/", // octal
    "https://127.1/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[0:0:0:0:0:ffff:7f00:1]/",
    "https://[64:ff9b::a9fe:a9fe]/",
    "https://[fe80::1]/",
    "https://localhost/",
    "https://localhost./",
    "https://foo.localhost/",
    "https://metadata.google.internal/",
  ]) {
    await assert.rejects(assertPublicHost(new URL(u)), Error, u);
  }
});

test("assertPublicHost: names are refused when any address they resolve to is internal, or when they resolve to nothing", async () => {
  const answers: Record<string, Array<{ address: string; family: number }>> = {
    "public.example": [{ address: "151.101.1.1", family: 4 }],
    "mixed.example": [
      { address: "151.101.1.1", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ],
    "mapped.example": [{ address: "::ffff:127.0.0.1", family: 6 }],
    "ula.example": [{ address: "fd00::5", family: 6 }],
    "empty.example": [],
  };
  publicHostNet.lookup = async (host) => answers[host] ?? [];
  await assertPublicHost(new URL("https://public.example/"));
  await assertPublicHost(new URL("https://PUBLIC.example./"));
  for (const h of ["mixed.example", "mapped.example", "ula.example", "empty.example"]) await assert.rejects(assertPublicHost(new URL(`https://${h}/`)), Error, h);
  await assert.rejects(assertPublicHost(new URL("http://public.example/")));
});

// ---------- pinned fetch: the address is checked as the connection is made ----------
import { publicFetch, pinnedLookup } from "./icons";
import { createServer } from "node:net";

test("the connection's own lookup refuses an internal answer (DNS rebinding)", async () => {
  const err = await new Promise<NodeJS.ErrnoException | null>((done) => pinnedLookup("localhost", {}, (e) => done(e)));
  assert.match(err?.message ?? "", /private network/);
});

test("publicFetch never connects to an internal address, even when one is listening", async (t) => {
  let connected = false;
  const server = createServer((s) => {
    connected = true;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  await assert.rejects(publicFetch(`https://localhost:${port}/`), /private network/);
  assert.equal(connected, false);
});

test("publicFetch is https only", async () => {
  await assert.rejects(publicFetch("http://example.com/"), /https only/);
});

// ---------- IP literals, which connect without a lookup ----------
import { isInternalLiteral, redirectedInit } from "./icons";

test("publicFetch refuses internal IP literals, which never reach the socket's lookup", async (t) => {
  let connected = false;
  const server = createServer((s) => {
    connected = true;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  for (const u of [`https://127.0.0.1:${port}/`, `https://[::1]:${port}/`, "https://10.1.2.3/", "https://[::ffff:127.0.0.1]/", "https://[fe80::1]/", "https://2130706433/"]) {
    await assert.rejects(publicFetch(u), /private network/, u);
  }
  assert.equal(connected, false);
});

test("isInternalLiteral judges literals only, brackets and all", () => {
  assert.equal(isInternalLiteral(new URL("https://[::1]/")), true);
  assert.equal(isInternalLiteral(new URL("https://192.168.0.1/")), true);
  assert.equal(isInternalLiteral(new URL("https://[2606:4700::1111]/")), false);
  assert.equal(isInternalLiteral(new URL("https://8.8.8.8/")), false);
  assert.equal(isInternalLiteral(new URL("https://example.com/")), false);
});

test("publicFetch keeps its checks when globalThis.fetch is replaced outside the test runner", async (t) => {
  const real = globalThis.fetch;
  const context = process.env.NODE_TEST_CONTEXT;
  let stubbed = false;
  globalThis.fetch = (async () => {
    stubbed = true;
    return new Response("ok");
  }) as typeof fetch;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    globalThis.fetch = real;
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  });
  await assert.rejects(publicFetch("https://127.0.0.1/"), /private network/);
  assert.equal(stubbed, false);
});

test("a redirect to another origin drops credentials; a 303 becomes a GET", () => {
  const init: RequestInit = {
    method: "POST",
    body: "x",
    headers: { Authorization: "Bearer t", Cookie: "a=b", "Proxy-Authorization": "p", "Content-Type": "text/plain", Accept: "application/json" },
  };
  assert.equal(redirectedInit(init, 307, new URL("https://a.example.com/x"), new URL("https://a.example.com/y")), init);
  const cross = redirectedInit(init, 307, new URL("https://a.example.com/x"), new URL("https://b.example.com/y"));
  const h = new Headers(cross.headers);
  assert.equal(h.get("authorization"), null);
  assert.equal(h.get("cookie"), null);
  assert.equal(h.get("proxy-authorization"), null);
  assert.equal(h.get("accept"), "application/json");
  assert.equal(cross.method, "POST");
  assert.equal(cross.body, "x");
  const seeOther = redirectedInit(init, 303, new URL("https://a.example.com/x"), new URL("https://a.example.com/y"));
  assert.equal(seeOther.method, "GET");
  assert.equal(seeOther.body, undefined);
  assert.equal(new Headers(seeOther.headers).get("authorization"), "Bearer t");
  assert.equal(new Headers(seeOther.headers).get("content-type"), null);
  // Another port is another origin.
  const port = redirectedInit(init, 302, new URL("https://a.example.com/"), new URL("https://a.example.com:8443/"));
  assert.equal(new Headers(port.headers).get("authorization"), null);
});
