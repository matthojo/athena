import test from "node:test";
import assert from "node:assert/strict";
import { isPublicUrl, imageJob, selectionJob, linkJob, pageJob, isSavablePage } from "../src/lib/capture.js";

test("public URLs", () => {
  for (const u of ["https://cdn.example.com/a.png", "http://example.org/x.jpg", "https://8.8.8.8/a.png"]) assert.ok(isPublicUrl(u), u);
  for (const u of [
    "data:image/png;base64,AAAA", "blob:https://example.com/123", "http://localhost/a.png", "http://intranet/a.png",
    "http://10.1.2.3/a.png", "http://192.168.1.4/a.png", "http://172.20.0.1/a.png", "http://127.0.0.1:3000/a.png",
    "http://169.254.1.1/a", "https://nas.local/a.png", "https://me:pw@example.com/a.png", "http://[::1]/a.png",
    "file:///Users/me/a.png", "not a url",
  ]) assert.equal(isPublicUrl(u), false, u);
});

const tab = { id: 1, url: "https://example.com/post", title: "A post" };

test("jobs carry the page they came from", () => {
  assert.deepEqual(pageJob(tab, "why").payload, { url: tab.url, title: "A post", note: "why" });
  assert.deepEqual(selectionJob(tab, " x\ny ").payload, { selection: " x\ny ", url: tab.url, title: "A post" });
  assert.deepEqual(linkJob(tab, "https://b.com", "B").payload, { url: "https://b.com", title: "B", source_url: tab.url });
  const img = imageJob(tab, "data:image/png;base64,AA", { dataUrl: "data:image/png;base64,AA" });
  assert.equal(img.payload.url, undefined, "a data: URL goes as bytes, not as a URL");
  assert.equal(img.payload.source_url, tab.url);
  const pub = imageJob(tab, "https://cdn.example.com/a.png");
  assert.deepEqual([pub.payload.url, pub.payload.image, pub.image], ["https://cdn.example.com/a.png", "https://cdn.example.com/a.png", null]);
  const bytes = imageJob(tab, "http://10.0.0.2/a.png", { dataUrl: "data:image/png;base64,AA" });
  assert.equal(bytes.payload.image, undefined, "bytes go as the file, not the URL");
  assert.ok(isSavablePage("https://a.com") && !isSavablePage("chrome://newtab") && !isSavablePage(undefined));
});
