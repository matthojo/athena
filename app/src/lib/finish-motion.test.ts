import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { MOTION_FALLBACK, finishPlan, flipDeltas, parseDuration, pendingFinishes } from "./finish-motion";

const styles = new URL("../styles/", import.meta.url);
const tokens = readFileSync(new URL("tokens.css", styles), "utf8");

test("parseDuration reads ms and s, and falls back on anything else", () => {
  assert.equal(parseDuration("320ms", 1), 320);
  assert.equal(parseDuration(" 0.8s ", 1), 800);
  assert.equal(parseDuration("", 200), 200);
  assert.equal(parseDuration("fast", 200), 200);
  assert.equal(parseDuration(undefined, 600), 600);
});

test("the fallbacks match the tokens", () => {
  for (const [name, ms] of Object.entries(MOTION_FALLBACK)) {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens);
    assert.ok(m, `${name} is in tokens.css`);
    assert.equal(parseDuration(m[1], -1), ms, name);
  }
});

test("finishing a to-do: the check lands, it rests, then folds; an emptied group follows halfway", () => {
  const t = { fast: 200, hold: 600, base: 320 };
  assert.deepEqual(finishPlan({ ...t, lastInGroup: false, reduced: false }), { collapseAt: 600, groupAt: null, doneAt: 920 });
  assert.deepEqual(finishPlan({ ...t, lastInGroup: true, reduced: false }), { collapseAt: 600, groupAt: 760, doneAt: 1080 });
  // Reopening uses the check's own length as the rest.
  assert.equal(finishPlan({ ...t, hold: 200, lastInGroup: false, reduced: false }).collapseAt, 200);
});

test("with reduced motion nothing waits", () => {
  assert.deepEqual(finishPlan({ fast: 200, hold: 600, base: 320, lastInGroup: true, reduced: true }), { collapseAt: 0, groupAt: null, doneAt: 0 });
});

test("flipDeltas: what stayed and moved, what's new, and what didn't move enough to count", () => {
  const before = new Map([
    ["a", 0],
    ["b", 100],
    ["c", 200],
    ["gone", 300],
  ]);
  const after = new Map([
    ["a", 0.3],
    ["b", 40],
    ["c", 140],
    ["new", 260],
  ]);
  const { moved, entered } = flipDeltas(before, after);
  assert.deepEqual([...moved], [
    ["b", 60],
    ["c", 60],
  ]);
  assert.deepEqual(entered, ["new"]);
});

test("every duration and easing in the stylesheets is a token", () => {
  const raw: string[] = [];
  for (const file of readdirSync(styles).filter((f) => f.endsWith(".css") && f !== "tokens.css")) {
    const css = readFileSync(new URL(file, styles), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""));
    css.split("\n").forEach((line, i) => {
      // The reduced-motion rule's near-zero lengths are the one exception.
      if (/0\.001ms|\b0ms !important/.test(line)) return;
      if (/(?<![\w.])\d*\.?\d+m?s\b/.test(line) || /cubic-bezier\(|(?<![\w-])linear\((?!-gradient)|:\s*(?:[^;]*\s)?(?:ease|ease-in|ease-out|ease-in-out|linear)(?=[\s;,)])(?![\w-])/.test(line.replace(/[\w-]*-gradient\([^)]*\)/g, "")))
        raw.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(raw, []);
});

/** A stand-in for window or document that records its listeners. */
function target(state = "visible") {
  const fns = new Map<string, Set<(e: Event) => void>>();
  return {
    visibilityState: state,
    addEventListener(type: string, fn: (e: Event) => void) {
      if (!fns.has(type)) fns.set(type, new Set());
      fns.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      fns.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of [...(fns.get(type) ?? [])]) fn(new Event(type));
    },
    count: () => [...fns.values()].reduce((n, s) => n + s.size, 0),
  };
}

test("pending finishes: listeners only while something waits", () => {
  const win = target();
  const doc = target();
  const q = pendingFinishes(win, doc);
  assert.equal(win.count() + doc.count(), 0);
  const drop = q.add(() => assert.fail("not flushed"));
  assert.equal(win.count(), 1);
  assert.equal(doc.count(), 1);
  drop();
  assert.equal(q.size, 0);
  assert.equal(win.count() + doc.count(), 0);
});

test("pending finishes: hiding the page saves everything waiting, once", () => {
  const win = target();
  const doc = target();
  const q = pendingFinishes(win, doc);
  const saved: string[] = [];
  q.add(() => saved.push("a"));
  q.add(() => saved.push("b"));
  doc.fire("visibilitychange"); // still visible: nothing yet
  assert.deepEqual(saved, []);
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  assert.deepEqual(saved, ["a", "b"]);
  assert.equal(win.count() + doc.count(), 0);
  win.fire("pagehide");
  assert.deepEqual(saved, ["a", "b"]);
});

test("pending finishes: pagehide flushes too", () => {
  const win = target();
  const doc = target();
  const q = pendingFinishes(win, doc);
  let saved = 0;
  q.add(() => saved++);
  win.fire("pagehide");
  assert.equal(saved, 1);
  assert.equal(q.size, 0);
});
