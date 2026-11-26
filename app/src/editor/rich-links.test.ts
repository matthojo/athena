/**
 * Rich links in the editor: opening a note and saving it keeps every link's
 * mode, the paste rules, the switcher's choices per link, what a tap does,
 * the menu for a web page, and no iframe before a tap.
 *
 * Runs in Node with a small DOM (linkedom). The round trips use a headless
 * editor (no view), which reads and writes Markdown through the same schema
 * as the app (extensions.ts).
 *
 *   npx tsx --test app/src/editor/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "Node", "HTMLElement", "Element", "Text", "DocumentFragment"]) g[k] ??= (window as unknown as Record<string, unknown>)[k];
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { Editor } = await import("@tiptap/core");
const { baseExtensions } = await import("./extensions");
const model = await import("./link-model");
const { renderLink, thingFor, loadPlayer, embedFrame, EMBED_SANDBOX } = await import("./link-render");
const { embedFor, EMBED_FRAME_HOSTS } = await import("../../../lib/embeds");
const { parseAthenaLinks, parseWebLinks } = await import("../../../lib/links");

const PRIYA = "5a3e0000-0000-4000-8000-000000000101";
const NOTE = "5a3e0000-0000-4000-8000-000000000001";

function roundTrip(md: string): string {
  const ed = new Editor({ element: null, extensions: baseExtensions(), content: md, contentType: "markdown" });
  const out = ed.getMarkdown();
  ed.destroy();
  return out;
}

const norm = (s: string) => s.trim().replace(/\n{3,}/g, "\n\n");

test("every mode survives open and save, Athena and web", () => {
  const md = [
    `Lunch with [@Priya Shah](athena://person/${PRIYA}) and [@Priya Shah](athena://person/${PRIYA} "link") about [Lisbon](athena://note/${NOTE}).`,
    "",
    `[@Priya Shah](athena://person/${PRIYA} "card")`,
    "",
    "Read [a slow walk](https://example.com/walk) and [the coffee piece](https://example.com/coffee \"mention\").",
    "",
    '[A slow walk](https://example.com/walk "card")',
    "",
    '[Canal locks](https://www.youtube.com/watch?v=dQw4w9WgXcQ "embed")',
  ].join("\n");
  const out = roundTrip(md);
  assert.equal(norm(out), norm(md));
  assert.deepEqual(parseAthenaLinks(out), parseAthenaLinks(md));
  assert.deepEqual(parseWebLinks(out), parseWebLinks(md));
});

test("a second open and save changes nothing", () => {
  const md = `Hi [@Priya Shah](athena://person/${PRIYA} "link")\n\n[Vimeo](https://vimeo.com/76979871 "embed")\n\n[Site](https://example.com "card")`;
  const once = roundTrip(md);
  assert.equal(roundTrip(once), once);
});

test("a Card or Embed written mid-sentence stays where it is, with its mode", () => {
  const md = `See [@Priya Shah](athena://person/${PRIYA} "card") and [the walk](https://example.com/walk "embed") today.`;
  assert.equal(norm(roundTrip(md)), norm(md));
});

test("an Athena link that says embed is saved as a card; the default is never written", () => {
  assert.equal(norm(roundTrip(`[@Priya](athena://person/${PRIYA} "embed")`)), `[@Priya](athena://person/${PRIYA} "card")`);
  assert.equal(norm(roundTrip(`[@Priya](athena://person/${PRIYA} "mention")`)), `[@Priya](athena://person/${PRIYA})`);
  assert.equal(norm(roundTrip(`[x](https://example.com "link")`)), `[x](https://example.com)`);
});

test("old notes are untouched: plain links, titles that aren't modes, bold link words", () => {
  for (const md of [
    `Talk to [@Priya Shah](athena://person/${PRIYA}) soon.`,
    'A [titled link](https://example.com "Example home") here.',
    "A [**bold** link](https://example.com/a) here.",
    "- [ ] a task with [a link](https://example.com)",
  ]) {
    assert.equal(norm(roundTrip(md)), norm(md));
  }
});

test("paste by position: Card or Embed on an empty line, Link in a sentence", () => {
  assert.equal(model.pasteMode("https://example.com/walk", "empty-line"), "card");
  assert.equal(model.pasteMode("https://youtu.be/dQw4w9WgXcQ", "empty-line"), "embed");
  assert.equal(model.pasteMode("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "empty-line"), "embed");
  assert.equal(model.pasteMode("https://youtu.be/dQw4w9WgXcQ", "in-text"), "link");
  assert.equal(model.pasteMode("https://example.com/walk", "in-text"), "link");
});

test("only a lone web address counts as a pasted link", () => {
  assert.equal(model.pastedUrl("  https://example.com/a?b=1 "), "https://example.com/a?b=1");
  assert.equal(model.pastedUrl("see https://example.com"), null);
  assert.equal(model.pastedUrl('<iframe src="https://www.youtube.com/embed/x"></iframe>'), null);
  assert.equal(model.pastedUrl("javascript:alert(1)"), null);
  assert.equal(model.pastedUrl("ftp://example.com/file"), null);
  assert.equal(model.pastedUrl("https://nodot"), null);
});

test("Card or Embed for a link in a sentence goes after the paragraph", () => {
  assert.equal(model.blockPlacement(false), "after");
  assert.equal(model.blockPlacement(true), "replace");
});

test("switcher choices per link", () => {
  const on = (t: Parameters<typeof model.switcherChoices>[0]) => model.switcherChoices(t).map((c) => `${c.mode}:${c.enabled ? "on" : c.reason}`);
  assert.deepEqual(on({ target: "athena", kind: "person", id: PRIYA }), ["mention:on", "link:on", "card:on", `embed:${model.ATHENA_NO_EMBED}`]);
  assert.deepEqual(on({ target: "web", url: "https://example.com/walk" }), ["mention:on", "link:on", "card:on", `embed:${model.NO_PLAYER}`]);
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/76979871",
    "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
    "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3",
    "https://www.figma.com/design/AbCdEf1234567890/Plan",
  ]) {
    assert.deepEqual(model.allowedModes({ target: "web", url }), ["mention", "link", "card", "embed"], url);
  }
});

test("a tap opens the link; the switcher isn't on tap", () => {
  // Mention, Link and Card open what they point at.
  for (const mode of ["mention", "link", "card"] as const) {
    assert.equal(model.tapAction(mode, true), "open", `${mode} in the editor`);
    assert.equal(model.tapAction(mode, false), "open", `${mode} read-only`);
  }
  // An Embed's still selects it in the editor (its button plays); read-only, it opens.
  assert.equal(model.tapAction("embed", true), "select");
  assert.equal(model.tapAction("embed", false), "open");
});

test("a web page's menu has Open and no Open in browser; Athena kinds keep their action", async () => {
  const { linkMenu } = await import("./link-context");
  const labels = (t: ReturnType<typeof thingFor>, mode: Parameters<typeof linkMenu>[1]) =>
    linkMenu(t, mode, { open() {}, show() {}, remove() {} }).groups.flat().map((a) => a.label);
  const web = labels(thingFor({ target: "web", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, "Canal locks", {}), "embed");
  assert.ok(web.includes("Open"));
  assert.ok(!web.includes("Open in browser"));
  assert.ok(web.includes("Show as"));
  const todo = labels(thingFor({ target: "athena", kind: "todo", id: NOTE }, "Book the van", {}), "mention");
  assert.ok(todo.includes("Mark done"));
});

test("an embed draws a still and our button, and no iframe until the tap", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const t = thingFor({ target: "web", url }, "Canal locks", {});
  let tapped: HTMLElement | null = null;
  const el = renderLink(t, "embed", "loaded", "Canal locks", { onPlay: (e) => (tapped = e) });
  assert.equal(el.querySelectorAll("iframe").length, 0);
  const play = el.querySelector("[data-rl-play]") as HTMLElement;
  assert.ok(play, "a play button");
  assert.match(play.getAttribute("aria-label") ?? "", /loads from YouTube/);
  // The tap: the player is made only now, with lib/embeds.ts's rules.
  play.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(tapped);
  const frame = loadPlayer(el, t)!;
  assert.equal(el.querySelectorAll("iframe").length, 1);
  const e = embedFor(url)!;
  assert.equal(frame.getAttribute("src"), e.embedUrl);
  assert.equal(frame.getAttribute("sandbox"), EMBED_SANDBOX);
  assert.equal(frame.getAttribute("allow"), e.allow);
  assert.equal(frame.getAttribute("referrerpolicy"), "strict-origin");
  assert.equal(frame.getAttribute("loading"), "lazy");
  assert.ok(EMBED_FRAME_HOSTS.some((h) => new URL(e.embedUrl!).origin === h));
});

test("a Framer site, anyone's, plays without popups; the players keep theirs", () => {
  const site = embedFrame(embedFor("https://studio-north.framer.website/")!, "Studio North")!;
  const sandbox = (site.getAttribute("sandbox") ?? "").split(" ");
  assert.ok(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin"));
  assert.ok(!sandbox.includes("allow-popups"), "no popups from a Framer site");
  assert.ok(!sandbox.some((flag) => flag.startsWith("allow-top-navigation")));
  for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://vimeo.com/76979871", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"]) {
    assert.equal(embedFrame(embedFor(url)!, "Player")!.getAttribute("sandbox"), EMBED_SANDBOX, url);
  }
});

test("Apple Maps never gets an iframe; every mode draws without one", () => {
  const url = "https://maps.apple.com/?ll=51.5,-0.12&q=Somewhere";
  const t = thingFor({ target: "web", url }, "Somewhere", {});
  for (const mode of model.MODES) {
    for (const state of ["loading", "loaded", "failed", "offline"] as const) {
      assert.equal(renderLink(t, mode, state).querySelectorAll("iframe").length, 0, `${mode} ${state}`);
    }
  }
  assert.equal(loadPlayer(renderLink(t, "embed"), t), null);
});

test("netlify.toml's frame-src allows every player host and nothing else third-party", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../../../netlify.toml", import.meta.url), "utf8");
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)?.[1] ?? "";
  const frameSrc = /frame-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/) ?? [];
  const third = frameSrc.filter((s) => s.startsWith("https://"));
  assert.deepEqual([...third].sort(), [...EMBED_FRAME_HOSTS].sort());
  assert.ok(frameSrc.includes("'self'") && frameSrc.includes("blob:"), "the PDF viewer's frame");
});
