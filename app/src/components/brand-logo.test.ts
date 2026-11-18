// Run: npx tsx --test app/src/components/brand-logo.test.ts
// Every connector shows its own mark or, where none can be drawn faithfully, its category icon (docs/notes/connectors-audit.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTOR_PRESETS } from "../../../lib/connector-presets";
import { ICON_FALLBACK, hasMark } from "./brand-logo";
import { icons } from "./icons";

const here = dirname(fileURLToPath(import.meta.url));
/** Every mark as written: its id, its SVG, and the comment line above it. */
function written(): Array<{ file: string; id: string; svg: string; above: string }> {
  const files = [join(here, "brand-logo.ts"), ...readdirSync(join(here, "brand-marks")).map((f) => join(here, "brand-marks", f))];
  return files.flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.flatMap((line, i) => {
      const m = /^ {2}"?([a-z0-9-]+)"?: `(<svg[^`]*)`,$/.exec(line);
      return m ? [{ file, id: m[1], svg: m[2], above: lines[i - 1] ?? "" }] : [];
    });
  });
}

test("every preset has a mark or an explicit fallback, never both", () => {
  for (const p of CONNECTOR_PRESETS) {
    const fallback = ICON_FALLBACK.includes(p.id);
    assert.ok(hasMark(p.id) !== fallback, `${p.id}: ${fallback ? "has a mark and a fallback" : "has no mark and no fallback"}`);
  }
});

test("a fallback names a real preset whose category icon exists", () => {
  for (const id of ICON_FALLBACK) {
    const p = CONNECTOR_PRESETS.find((x) => x.id === id);
    assert.ok(p, `${id} isn't a preset`);
    assert.ok(p.icon in icons, `${id}: no icon "${p.icon}"`);
  }
});

test("every mark is for a preset, is hidden from screen readers, and says where it came from", () => {
  const ids = new Set(CONNECTOR_PRESETS.map((p) => p.id));
  // ElevenLabs is the voice connection's mark, not a preset (voice-connection.ts).
  ids.add("elevenlabs");
  const marks = written();
  assert.ok(marks.length >= 75, `found ${marks.length} marks`);
  for (const m of marks) {
    assert.ok(ids.has(m.id), `${m.id} in ${m.file} isn't a preset`);
    assert.match(m.svg, /^<svg [^>]*viewBox="[^"]+"/, `${m.id}: no viewBox`);
    assert.match(m.svg, /aria-hidden="true"/, `${m.id}: not aria-hidden`);
    // Drawn inline: nothing fetched, nothing that could leak which services the owner uses.
    assert.doesNotMatch(m.svg, /https?:|href|<image|<script|<style/i, `${m.id}: must be self-contained`);
    assert.match(m.above, /^ {2}\/\/ .+\(checked \d{1,2} Nov 2026\)$/, `${m.id}: no source comment`);
  }
});

test("ids inside marks are unique across marks, so two on one page can't take each other's gradients", () => {
  const seen = new Map<string, string>();
  for (const m of written())
    for (const [, id] of m.svg.matchAll(/\bid="([^"]+)"/g)) {
      assert.ok(!seen.has(id) || seen.get(id) === m.id, `id "${id}" is in ${seen.get(id)} and ${m.id}`);
      seen.set(id, m.id);
    }
});
