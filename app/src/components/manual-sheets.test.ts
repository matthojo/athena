/**
 * The four manual-entry sheets opened with starting values, as Ask's logging cards' Edit does, and
 * without, as their pages do: a sheet given values shows them and saves what's in it through the same route; one
 * given none opens as it always has. A small DOM (linkedom), with the API answered by a stubbed fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { parseHTML } from "linkedom";

// The sheets import their stylesheet; Node can't, so a .css import is an empty module here.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function load(url, ctx, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, ctx); }`)
);

const { window } = parseHTML("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "Node", "HTMLElement", "Element", "Text", "Event", "CustomEvent", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLButtonElement", "HTMLFormElement"])
  g[k] ??= (window as unknown as Record<string, unknown>)[k];
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
g.sessionStorage = g.localStorage;
g.history = { state: null, pushState() {}, replaceState() {}, back() {} };
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const proto = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype;
proto.showModal = function (this: { open: boolean }) {
  this.open = true;
};
proto.close = function (this: { open: boolean }) {
  this.open = false;
};
(window as unknown as Record<string, unknown>).addEventListener ??= () => undefined;
// linkedom's <select> can't be set: a value is the option marked selected, as in a browser.
Object.defineProperty((window as unknown as { HTMLSelectElement: { prototype: object } }).HTMLSelectElement.prototype, "value", {
  configurable: true,
  get(this: HTMLSelectElement) {
    const opts = [...this.querySelectorAll("option")];
    return (opts.find((o) => o.hasAttribute("selected")) ?? opts[0])?.getAttribute("value") ?? "";
  },
  set(this: HTMLSelectElement, v: string) {
    for (const o of this.querySelectorAll("option")) o.toggleAttribute("selected", o.getAttribute("value") === v);
  },
});

/** What the sheets sent, and what the stubbed API answers. */
const sent: Array<{ method: string; path: string; body: unknown }> = [];
let answer: (path: string, method: string, body: unknown) => unknown = () => ({});
g.fetch = async (url: string, init: RequestInit = {}) => {
  const path = String(url).replace(/^.*\/api/, "");
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  sent.push({ method, path, body });
  return new Response(JSON.stringify(answer(path, method, body)), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { openSpendingSheet } = await import("./spending-sheet");
const { openHealthLogSheet } = await import("./health-log-sheet");
const { openDayEntrySheet } = await import("./day-entry-sheet");
const { openMeterReadingSheet } = await import("./meter-reading-sheet");
const { localToday } = await import("../lib/time");
const { addDays } = await import("../../../lib/dates");

const settle = () => new Promise((r) => setTimeout(r, 5));
/** The sheet open now, and its inputs by aria-label. */
function sheet() {
  const all = document.querySelectorAll("dialog");
  const d = all[all.length - 1] as HTMLElement;
  assert.ok(d, "a sheet is open");
  return {
    el: d,
    field: (label: string) => d.querySelector(`input[aria-label="${label}"], select[aria-label="${label}"]`) as HTMLInputElement,
    title: () => d.querySelector("textarea") as HTMLTextAreaElement,
    submit: async () => {
      const form = d.querySelector("form");
      if (form) form.dispatchEvent(new window.Event("submit", { cancelable: true }) as unknown as Event);
      else ([...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add") as HTMLButtonElement).click();
      await settle();
    },
  };
}
function reset() {
  for (const d of document.querySelectorAll("dialog")) d.remove();
  sent.length = 0;
  answer = () => ({});
}

test("spending: opened with the card's values it shows them, and Add saves what's in it with its currency", async () => {
  reset();
  const yesterday = addDays(localToday(), -1);
  answer = (_p, _m, b) => ({ id: "p1", time: "12:00", ...(b as object) });
  let added: unknown = null;
  openSpendingSheet((p) => (added = p), { date: yesterday, start: { merchant: "Coffee", amount: 1250, currency: "EUR", category: "eating_out" } });
  const s = sheet();
  assert.equal(s.title().value, "Coffee");
  assert.equal(s.field("Amount in EUR").value, "12.50");
  assert.equal(s.field("Kind of spending").value, "eating_out");
  assert.equal(s.field("Day").value, yesterday);
  assert.equal(s.el.querySelector(".manual-amount__sign")?.textContent, "€");
  s.field("Amount in EUR").value = "13";
  await s.submit();
  assert.deepEqual(sent.at(-1), { method: "POST", path: "/life/spending", body: { merchant: "Coffee", amount: 1300, category: "eating_out", date: yesterday, currency: "EUR" } });
  assert.equal((added as { id: string } | null)?.id, "p1");
});

test("spending: opened without values it's empty, in pounds, and sends no currency", async () => {
  reset();
  answer = (_p, _m, b) => ({ id: "p2", time: "12:00", currency: "GBP", ...(b as object) });
  openSpendingSheet(() => undefined);
  const s = sheet();
  assert.equal(s.title().value, "");
  assert.equal(s.field("Amount in pounds").value, "");
  assert.equal(s.field("Kind of spending").value, "general");
  assert.equal(s.field("Day").value, localToday());
  assert.equal(s.el.querySelector(".manual-amount__sign")?.textContent, "£");
  s.title().value = "Market";
  s.field("Amount in pounds").value = "4.50";
  await s.submit();
  assert.deepEqual(sent.at(-1)?.body, { merchant: "Market", amount: 450, category: "general", date: localToday() });
});

test("health: the card's figures are laid over the day's typed ones, and Save keeps both", async () => {
  reset();
  const day = addDays(localToday(), -1);
  const typed = { steps: 8400, weight_kg: 72.4, workouts: [{ type: "walk", minutes: 20 }] };
  answer = (p, m) => (m === "GET" && p.startsWith("/health/manual") ? { figures: typed, health: typed, manual: typed } : { ok: true });
  let saved: unknown = null;
  openHealthLogSheet((x) => (saved = x), { date: day, start: { sleep_minutes: 420, workouts: [{ type: "run", minutes: 28, distance_m: 5000 }] } });
  const s = sheet();
  // Before the day loads: the card's figures alone.
  assert.equal(s.field("Hours asleep").value, "7");
  assert.equal(s.field("Workout").value, "run");
  await settle();
  const get = sent.find((x) => x.method === "GET");
  assert.ok(get?.path.includes(day), "the day's typed figures are read");
  if (s.field("Steps").value === "") return assert.fail(`the day's typed figures weren't loaded: ${JSON.stringify(sent)}`);
  assert.equal(s.field("Steps").value, "8400");
  assert.equal(s.field("Weight in kilograms").value, "72.4");
  assert.equal(s.field("Hours asleep").value, "7");
  // The card's workout is the one the form shows; the walk typed before is kept beside it.
  assert.equal(s.field("Workout").value, "run");
  assert.equal(s.field("Workout minutes").value, "28");
  assert.equal(s.field("Workout distance in km").value, "5");
  await s.submit();
  const put = sent.at(-1)!;
  assert.equal(put.method, "PUT");
  const body = put.body as Record<string, unknown>;
  const figures = (body.figures ?? body) as Record<string, unknown>;
  assert.equal(figures.steps, 8400);
  assert.equal(figures.weight_kg, 72.4);
  assert.equal(figures.sleep_minutes, 420);
  assert.deepEqual(figures.workouts, [{ type: "run", minutes: 28, distance_m: 5000 }, { type: "walk", minutes: 20 }]);
  assert.deepEqual((saved as { before: unknown } | null)?.before, typed);
});

test("health: opened without values it shows only what was typed in for the day", async () => {
  reset();
  const typed = { steps: 8400 };
  answer = (p, m) => (m === "GET" && p.startsWith("/health/manual") ? { figures: typed, health: typed, manual: typed } : { ok: true });
  openHealthLogSheet(() => undefined);
  const s = sheet();
  assert.equal(s.field("Day").value, addDays(localToday(), -1));
  assert.equal(s.field("Hours asleep").value, "");
  assert.equal(s.field("Workout").value, "");
  await settle();
  assert.equal(s.field("Steps").value, "8400");
  assert.equal(s.field("Hours asleep").value, "");
});

test("day entry: opened with the card's values it shows them, and Add answers with the entry and its id", async () => {
  reset();
  answer = () => ({ id: "e1", date: "2026-11-13" });
  let got: unknown = null;
  openDayEntrySheet("2026-11-13", (entry, id) => (got = { entry, id }), { kind: "listened", start: { title: "Blue", subtitle: "Joni Mitchell", minutes: 36 } });
  const s = sheet();
  assert.equal(s.title().value, "Blue");
  assert.equal(s.field("Minutes").value, "36");
  assert.ok([...s.el.querySelectorAll("input")].some((i) => i.value === "Joni Mitchell"));
  assert.equal(s.el.querySelector('[aria-pressed="true"], [aria-checked="true"]')?.textContent?.trim(), "Listened");
  await s.submit();
  assert.deepEqual(sent.at(-1), { method: "POST", path: "/days/2026-11-13/entries", body: { kind: "listened", title: "Blue", subtitle: "Joni Mitchell", minutes: 36 } });
  assert.deepEqual(got, { entry: { kind: "listened", title: "Blue", subtitle: "Joni Mitchell", minutes: 36 }, id: "e1" });
});

test("day entry: opened without values it's empty and Watched", async () => {
  reset();
  openDayEntrySheet("2026-11-13", () => undefined);
  const s = sheet();
  assert.equal(s.title().value, "");
  assert.equal(s.field("Minutes").value, "");
  assert.ok([...s.el.querySelectorAll("input")].every((i) => i.value === ""));
  assert.equal(s.el.querySelector('[aria-pressed="true"], [aria-checked="true"]')?.textContent?.trim(), "Watched");
});

test("meter reading: opened with the card's values it shows them, and Save answers with the reading saved", async () => {
  reset();
  const day = addDays(localToday(), -2);
  const before = [{ id: "r0", fuel: "gas", date: addDays(day, -10), value: 900, unit: "m3" }] as const;
  answer = (_p, _m, b) => ({ readings: [{ id: "r1", ...(b as object) }, ...before] });
  let got: unknown = null;
  openMeterReadingSheet([...before], (next, made) => (got = { n: next.length, made }), { fuel: "gas", start: { value: 1000.5, unit: "ft3", date: day } });
  const s = sheet();
  assert.equal(s.field("Meter reading").value, "1000.5");
  assert.equal(s.field("Unit").value, "ft3");
  assert.equal(s.field("Day read").value, day);
  await s.submit();
  assert.deepEqual(sent.at(-1), { method: "POST", path: "/life/readings", body: { fuel: "gas", date: day, value: 1000.5, unit: "ft3" } });
  assert.deepEqual(got, { n: 2, made: { id: "r1", fuel: "gas", date: day, value: 1000.5, unit: "ft3" } });
});

test("meter reading: opened without values it's empty, today, and the gas unit is the last one used", async () => {
  reset();
  openMeterReadingSheet([{ id: "r0", fuel: "gas", date: "2026-11-01", value: 900, unit: "kwh" }], () => undefined);
  const s = sheet();
  assert.equal(s.field("Meter reading").value, "");
  assert.equal(s.field("Unit").value, "kwh");
  assert.equal(s.field("Day read").value, localToday());
});
