import test from "node:test";
import assert from "node:assert/strict";
import { buildSaveRequest, buildNoteRequest, buildTestRequest, classify, itemLink, send } from "../src/lib/api.js";

const settings = { origin: "https://athena.example.com", key: "athc_" + "k".repeat(43) };

test("page save: JSON with source and client id", () => {
  const job = { id: "j1", kind: "page", payload: { url: "https://example.com/a", title: "A", note: "" } };
  const { url, init } = buildSaveRequest(settings, job);
  assert.equal(url, "https://athena.example.com/api/saved");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${settings.key}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    url: "https://example.com/a", title: "A", kind: "page", source: "extension", client_id: "j1",
  });
});

test("quote: the selection goes through byte for byte", () => {
  const text = "  First line,\n\tsecond — with “quotes” & <tags>  \n\n";
  const job = { id: "j2", kind: "selection", payload: { selection: text, url: "https://e.com", title: "E" } };
  const body = JSON.parse(buildSaveRequest(settings, job).init.body);
  assert.equal(body.selection, text);
  assert.equal(body.url, "https://e.com");
});

test("image with bytes: multipart with the file and the URL", async () => {
  const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString("base64");
  const job = {
    id: "j3", kind: "image",
    payload: { url: "http://10.0.0.5/cat.png", source_url: "http://10.0.0.5/", title: "Cats" },
    image: { dataUrl: png, name: "cat.png" },
  };
  const { init } = buildSaveRequest(settings, job);
  assert.ok(init.body instanceof FormData);
  assert.equal(init.headers["Content-Type"], undefined, "fetch sets the multipart boundary");
  assert.equal(init.body.get("url"), "http://10.0.0.5/cat.png");
  assert.equal(init.body.get("source"), "extension");
  assert.equal(init.body.get("client_id"), "j3");
  const file = init.body.get("image");
  assert.equal(file.name, "cat.png");
  assert.equal(file.type, "image/png");
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [137, 80, 78, 71, 1, 2, 3]);
});

test("public image: JSON, with the URL in image", () => {
  const job = { id: "j4", kind: "image", payload: { url: "https://cdn.example.com/a.jpg", image: "https://cdn.example.com/a.jpg", source_url: "https://example.com" } };
  const { init } = buildSaveRequest(settings, job);
  assert.equal(typeof init.body, "string");
  assert.equal(JSON.parse(init.body).image, "https://cdn.example.com/a.jpg");
});

test("note after a save: the same save again, same client id, no bytes", () => {
  const n = buildNoteRequest(settings, {
    id: "j1", kind: "note", image: { dataUrl: "data:image/png;base64,AA" },
    payload: { kind: "image", url: "https://e.com/a.png", source_url: "https://e.com", note: "hi" },
  });
  assert.equal(n.url, "https://athena.example.com/api/saved");
  assert.equal(n.init.method, "POST");
  assert.deepEqual(JSON.parse(n.init.body), {
    url: "https://e.com/a.png", note: "hi", source_url: "https://e.com", kind: "image", source: "extension", client_id: "j1",
  });
});

test("test request", () => {
  const t = buildTestRequest(settings);
  assert.equal(t.url, "https://athena.example.com/api/saved/ping");
  assert.equal(t.init.method, "GET");
});

test("classify answers", () => {
  assert.equal(classify(201).kind, "ok");
  assert.equal(classify(401).kind, "auth");
  assert.equal(classify(403).kind, "auth");
  assert.equal(classify(404).kind, "rejected");
  assert.equal(classify(413, { error: "Too big" }).message, "Too big");
  for (const s of [0, 408, 429, 500, 502, 503]) assert.equal(classify(s).kind, "transient", String(s));
});

test("item link: same-origin url, else built from id", () => {
  assert.equal(itemLink(settings.origin, { url: "https://athena.example.com/#/saved/7" }), "https://athena.example.com/#/saved/7");
  assert.equal(itemLink(settings.origin, { url: "https://evil.example/x", id: 7 }), "https://athena.example.com/#/saved/7");
  assert.equal(itemLink(settings.origin, null), "https://athena.example.com/#/saved");
});

test("send: a network failure is transient and never throws", async () => {
  const res = await send(async () => { throw new TypeError("Failed to fetch"); }, buildTestRequest(settings));
  assert.equal(res.kind, "transient");
  assert.equal(res.status, 0);
});

test("send: never sends cookies, never follows redirects", async () => {
  let seen;
  await send(async (url, init) => { seen = init; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }, buildTestRequest(settings));
  assert.equal(seen.credentials, "omit");
  assert.equal(seen.redirect, "error");
});
