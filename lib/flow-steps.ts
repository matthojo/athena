/**
 * Flows: the pure half of a run (lib/flow-run.ts does the rest). How values pass between steps (a trigger's or
 * an earlier step's, by ValueRef), how a step's text and a tool's input are filled from them, how a Check
 * decides, when a Wait carries on, where a run is in the tree of steps, and the line each step leaves on the run
 * page. Lines are written from what happened, never by a model, in plain British English (lib/writing-style.ts).
 * Nothing here reads the database or calls a model.
 */
import type { Anthropic } from "./ai";
import { addDays, zonedParts, zonedToInstant, zonedToday } from "./dates";
import { FLOW_LIMITS, type FlowCondition, type FlowStep, type FlowText, type FlowValue, type ValueRef } from "./flow-types";

// ---------- values ----------

/** A record in Athena a step found or made: its id for later steps' fields, its title for words. */
export interface RecordVal {
  id: string;
  title: string;
  kind?: string;
}
export interface MoneyVal {
  amount: number;
  currency: string;
}
export type FlowVal = string | number | boolean | RecordVal | MoneyVal | null;
/** Everything the run knows so far: the trigger's values under "trigger", each step's under its id. */
export type FlowValues = Record<string, Record<string, FlowVal>>;

export const isRecord = (v: unknown): v is RecordVal => !!v && typeof v === "object" && typeof (v as RecordVal).id === "string" && typeof (v as RecordVal).title === "string";
export const isMoney = (v: unknown): v is MoneyVal => !!v && typeof v === "object" && typeof (v as MoneyVal).amount === "number" && typeof (v as MoneyVal).currency === "string";

const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
const CODE: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };

/** "£38.00". Pure. */
export function moneyWords(m: MoneyVal): string {
  const sym = SYMBOL[m.currency];
  const n = Math.abs(m.amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${m.amount < 0 ? "-" : ""}${sym ?? ""}${n}${sym ? "" : ` ${m.currency}`}`;
}

/** "£38.00", "38.00 GBP", "-£4.50" → money; anything else null. Pure. */
export function parseMoney(raw: unknown): MoneyVal | null {
  if (isMoney(raw)) return raw;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(-)?\s*([£€$])?\s*(-)?([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?$/);
  if (!m || (!m[2] && !m[5])) return null;
  const amount = Number(m[4].replace(/,/g, "")) * (m[1] || m[3] ? -1 : 1);
  return Number.isFinite(amount) ? { amount, currency: m[5] ?? CODE[m[2]] ?? "GBP" } : null;
}

/** A value as a number, when it is one: a number, money's amount, or text that reads as one ("12", "£38.00", "1,200"). Pure. */
export function numberOf(v: FlowVal | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (isMoney(v)) return v.amount;
  if (typeof v !== "string") return null;
  const money = parseMoney(v);
  if (money) return money.amount;
  const t = v.trim().replace(/,/g, "");
  return /^-?\d+(?:\.\d+)?%?$/.test(t) ? Number(t.replace(/%$/, "")) : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DAY_WORDS = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Thu 27 Nov". Pure. */
export const dayWords = (date: string): string => DAY_WORDS.format(new Date(`${date}T12:00:00Z`));

/** A value in words, for text and lines: a record's title, money as "£38.00", a date as "Thu 27 Nov". Pure. */
export function valueWords(v: FlowVal | undefined, tz?: string): string {
  if (v == null) return "";
  if (typeof v === "string") {
    if (DATE.test(v)) return dayWords(v);
    if (DATETIME.test(v) && tz && !Number.isNaN(Date.parse(v))) {
      const p = zonedParts(new Date(v), tz);
      return `${dayWords(p.date)}, ${p.time}`;
    }
    return v;
  }
  if (typeof v === "number") return v.toLocaleString("en-GB");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (isMoney(v)) return moneyWords(v);
  if (isRecord(v)) return v.title;
  return "";
}

/**
 * A value as triggers give it (lib/flow-triggers.ts), in the shapes a run reads: a person or a linked record as
 * { id, title }, a company with no record as its name, a title that's unknown as "", and a list as its one item, or
 * its names joined when there are several. Pure.
 */
export function triggerVal(x: unknown): FlowVal {
  if (x == null) return null;
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return x;
  if (isMoney(x)) return x;
  if (Array.isArray(x)) {
    const list = x.map(triggerVal).filter((v): v is FlowVal => v != null && v !== "");
    if (list.length <= 1) return list[0] ?? null;
    return list.map((v) => valueWords(v)).filter(Boolean).join(", ");
  }
  if (typeof x !== "object") return null;
  const o = x as { id?: unknown; title?: unknown; name?: unknown; kind?: unknown };
  const words = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : "";
  if (typeof o.id !== "string" || !o.id) return words || null;
  return { id: o.id, title: words, ...(typeof o.kind === "string" && o.kind ? { kind: o.kind } : {}) };
}

/** A trigger's values, each in the shapes a run reads (triggerVal); nothing for an empty one. Pure. */
export function triggerValues(raw: Record<string, unknown> | undefined): Record<string, FlowVal> {
  const out: Record<string, FlowVal> = {};
  for (const [k, x] of Object.entries(raw ?? {})) {
    const v = triggerVal(x);
    if (v != null && v !== "") out[k] = v;
  }
  return out;
}

/** Is there something here? Empty text, null and missing are nothing. Pure. */
export const present = (v: FlowVal | undefined): boolean => v != null && !(typeof v === "string" && !v.trim());

/** A value by its pointer. Pure. */
export const valueAt = (values: FlowValues, ref: ValueRef): FlowVal | undefined => values[ref.from]?.[ref.key];

export const isRef = (x: unknown): x is ValueRef => !!x && typeof x === "object" && typeof (x as ValueRef).from === "string" && typeof (x as ValueRef).key === "string";

/** A step needed a value no earlier step gave. The run stops there, saying which. */
export class MissingValue extends Error {
  constructor(readonly ref: ValueRef) {
    super(`missing value ${ref.from}.${ref.key}`);
    this.name = "MissingValue";
  }
}

/** Text with its chips filled in. Throws MissingValue when a chip has nothing behind it. Pure. */
export function fillText(text: FlowText, values: FlowValues, tz?: string, each: (words: string) => string = (w) => w): string {
  return text
    .map((piece) => {
      if (typeof piece === "string") return piece;
      const v = valueAt(values, piece);
      if (!present(v)) throw new MissingValue(piece);
      return each(valueWords(v, tz));
    })
    .join("");
}

/** Text with each chip shown by its label in brackets ("[the company]"): for a dry run's would-be words. Pure. */
export function sketchText(text: FlowText, labels: Map<string, string>): string {
  return text.map((p) => (typeof p === "string" ? p : `[${labels.get(refKey(p)) ?? p.key}]`)).join("");
}

export const refKey = (r: ValueRef): string => `${r.from}.${r.key}`;

type Prop = { type?: unknown; items?: { type?: unknown }; enum?: unknown[] };

/**
 * A tool's input from a step's fields. A field that is a single chip passes the value itself where the tool wants
 * one: a record's id to an `_id` field, a number to a number field. Anything else is filled as text and read the
 * way the tool's schema says (a number, true or false, a list split at commas). An empty field is left out. Throws
 * MissingValue for a chip with nothing behind it. Pure.
 */
export function toolInput(fields: Record<string, FlowText>, tool: Pick<Anthropic.Tool, "input_schema">, values: FlowValues, tz?: string): Record<string, unknown> {
  const props = ((tool.input_schema as { properties?: Record<string, Prop> }).properties ?? {}) as Record<string, Prop>;
  const out: Record<string, unknown> = {};
  for (const [key, text] of Object.entries(fields)) {
    if (!(key in props) || key === "step" || !Array.isArray(text) || !text.length) continue;
    const prop = props[key];
    const idField = key === "id" || key.endsWith("_id");
    const idsField = key.endsWith("_ids");
    if (text.length === 1 && isRef(text[0])) {
      const v = valueAt(values, text[0]);
      if (!present(v)) throw new MissingValue(text[0]);
      if ((idField || idsField) && isRecord(v)) {
        out[key] = idsField ? [v.id] : v.id;
        continue;
      }
      if ((prop.type === "number" || prop.type === "integer") && numberOf(v) != null) {
        out[key] = prop.type === "integer" ? Math.round(numberOf(v)!) : numberOf(v);
        continue;
      }
      if (prop.type === "string" && /(^|_)(date|on|from|to)$/.test(key)) {
        if (DATE.test(String(v))) {
          out[key] = v;
          continue;
        }
        // A date and time (a booking's start) in a date field: its day, where the owner is.
        if (typeof v === "string" && DATETIME.test(v) && tz && !Number.isNaN(Date.parse(v))) {
          out[key] = zonedToday(new Date(v), tz);
          continue;
        }
      }
    }
    const filled = fillText(text, values, tz).trim();
    if (!filled) continue;
    if (prop.type === "number" || prop.type === "integer") {
      const n = numberOf(filled);
      if (n != null) out[key] = prop.type === "integer" ? Math.round(n) : n;
    } else if (prop.type === "boolean") out[key] = /^(yes|true|on|1)$/i.test(filled);
    else if (prop.type === "array") out[key] = filled.split(/\s*,\s*/).filter(Boolean);
    else out[key] = filled;
  }
  return out;
}

// ---------- a tool's result as values ----------

const LISTS = ["people", "notes", "todos", "items", "results", "records", "payments", "trips", "saved", "matches", "list"];

function firstList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  for (const k of LISTS) if (Array.isArray(o[k])) return o[k] as unknown[];
  for (const val of Object.values(o)) if (Array.isArray(val) && val.length && typeof val[0] === "object") return val;
  return null;
}

function recordOf(x: unknown, kind?: string): RecordVal | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : null;
  const title = [o.name, o.title, o.text, o.item, o.merchant].find((t): t is string => typeof t === "string" && !!t.trim());
  return id ? { id, title: title ?? "", ...(kind ? { kind } : {}) } : null;
}

/**
 * What a tool step gives later steps, from its result and the changes it made. `count`, `total` and `latest` read
 * the result's own numbers; a record value is what the step made, else the first thing it found; `result` and
 * `done` are the step's line. A value the result doesn't hold is left out (a later step that needs it stops). Pure.
 */
export function toolValues(gives: FlowValue[], result: string, changes: Array<{ id: string; title: string; label?: string; kind?: string }>, line: string): Record<string, FlowVal> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = null;
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const list = firstList(parsed);
  const out: Record<string, FlowVal> = {};
  for (const g of gives) {
    if (g.key === "count") {
      const n = typeof obj.total === "number" ? obj.total : typeof obj.count === "number" ? obj.count : list ? list.length : parsed === null && /^No /.test(result) ? 0 : null;
      if (n != null) out.count = n;
    } else if (g.key === "total") {
      const m = parseMoney(obj.total);
      if (m) out.total = m;
    } else if (g.key === "latest") {
      const first = list?.[0] as Record<string, unknown> | undefined;
      const m = parseMoney(first?.amount);
      if (m) out.latest = m;
    } else if (g.key === "result" || g.key === "done" || g.key === "answer") {
      if (line) out[g.key] = line;
    } else {
      const made = changes[0];
      // A record keeps its id for a later step's field and its title for words, whatever kind of chip it shows as.
      const rec = made ? { id: made.id, title: made.title, kind: g.kind } : recordOf(list?.[0], g.kind);
      if (rec) out[g.key] = rec;
    }
  }
  return out;
}

/**
 * A look's line where the result says more than lib/steps.ts's words do: "Found 12 payments to Northwind
 * Broadband: £384.00 in all". Null for the rest. Pure.
 */
export function lookLine(tool: string, result: string): string | null {
  if (tool !== "money") return null;
  let o: { count?: unknown; total?: unknown; payments?: Array<{ merchant?: unknown }> };
  try {
    o = JSON.parse(result);
  } catch {
    return /^No payments/.test(result) ? "Found no payments" : null;
  }
  if (typeof o?.count !== "number") return null;
  const merchants = new Set((o.payments ?? []).map((p) => (typeof p.merchant === "string" ? p.merchant : "")));
  const to = merchants.size === 1 && ![...merchants][0].startsWith("Unknown") ? ` to ${clip([...merchants][0], 60)}` : "";
  const total = parseMoney(o.total);
  return `Found ${o.count === 1 ? "1 payment" : `${o.count} payments`}${to}${total ? `: ${moneyWords(total)} in all` : ""}`;
}

// ---------- checks ----------

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export interface CheckOutcome {
  yes: boolean;
  /** "Yes: £38.00 is 19% more than £32.00". */
  line: string;
}

/** A Check's verdict and its line. A comparison with nothing on its left is a no. Pure. */
export function decide(c: FlowCondition, values: FlowValues, labels: Map<string, string>, tz?: string): CheckOutcome {
  const left = valueAt(values, c.left);
  const label = labels.get(refKey(c.left)) ?? c.left.key;
  const has = present(left);
  if (c.op === "exists") return { yes: has, line: has ? `Yes: there's ${label}` : `No: there's no ${label}` };
  if (c.op === "missing") return { yes: !has, line: has ? `No: there's ${label}` : `Yes: there's no ${label}` };
  if (!has) return { yes: false, line: `No: nothing was found for ${label}` };
  const right: FlowVal | undefined = isRef(c.right) ? valueAt(values, c.right) : (c.right as FlowVal | undefined);
  const L = valueWords(left, tz);
  const R = valueWords(right, tz);
  const say = (yes: boolean, detail: string): CheckOutcome => ({ yes, line: `${yes ? "Yes" : "No"}: ${detail}` });
  switch (c.op) {
    case "is":
    case "is_not": {
      const ln = numberOf(left);
      const rn = numberOf(right ?? null);
      const same = ln != null && rn != null ? ln === rn : fold(L) === fold(R);
      const yes = c.op === "is" ? same : !same;
      return say(yes, `${L} ${same ? "is" : "isn't"} ${R}`);
    }
    case "contains": {
      const yes = !!R && fold(L).includes(fold(R));
      return say(yes, `“${clip(L, 60)}” ${yes ? "has" : "doesn't have"} “${R}” in it`);
    }
    case "more_than":
    case "less_than": {
      const ln = numberOf(left);
      const rn = numberOf(right ?? null);
      let yes: boolean;
      if (ln != null && rn != null) yes = c.op === "more_than" ? ln > rn : ln < rn;
      else if (typeof left === "string" && typeof right === "string" && (DATE.test(left) || DATETIME.test(left))) yes = c.op === "more_than" ? left > right : left < right;
      else return { yes: false, line: `No: ${L} can't be compared with ${R || "nothing"}` };
      const word = c.op === "more_than" ? "more" : "less";
      const dated = typeof left === "string" && (DATE.test(left) || DATETIME.test(left));
      return say(yes, dated ? `${L} is ${yes ? "" : "not "}${c.op === "more_than" ? "after" : "before"} ${R}` : `${L} is ${yes ? "" : "not "}${word} than ${R}`);
    }
    case "up_by_pct": {
      const against = c.against ? valueAt(values, c.against) : undefined;
      const ln = numberOf(left);
      const an = numberOf(against ?? null);
      const want = numberOf((typeof c.right === "number" || typeof c.right === "string" ? c.right : null) as FlowVal) ?? 0;
      if (ln == null || an == null || an === 0) return { yes: false, line: `No: nothing to compare ${L} with` };
      const pct = ((ln - an) / Math.abs(an)) * 100;
      const A = valueWords(against, tz);
      const yes = pct >= want && pct > 0;
      const round = Math.round(Math.abs(pct));
      const detail = Math.abs(pct) < 0.5 ? `${L} is the same as ${A}` : `${L} is ${round}% ${pct > 0 ? "more" : "less"} than ${A}`;
      return say(yes, detail);
    }
  }
  return { yes: false, line: "No" };
}

// ---------- waits ----------

/** The default time of day a Wait carries on when it names a day but no time. */
export const WAIT_AT = "09:00";

/**
 * When a Wait carries on. `days` after now (at `at` on that day in the owner's zone, or exactly `days` × 24 hours
 * on when `at` is null); or `days` before a date value, at `at` (09:00 when none). Never more than
 * FLOW_LIMITS.waitDays away. Null when the date it waits for isn't there. Pure.
 */
export function waitUntil(step: Extract<FlowStep, { kind: "wait" }>, values: FlowValues, now: Date, tz: string): Date | null {
  const days = Math.max(0, Math.min(FLOW_LIMITS.waitDays, Math.floor(step.days || 0)));
  let at: Date;
  if (step.before) {
    const v = valueAt(values, step.before);
    const raw = typeof v === "string" ? v : isRecord(v) ? "" : "";
    const date = DATE.test(raw) ? raw : DATETIME.test(raw) && !Number.isNaN(Date.parse(raw)) ? zonedToday(new Date(raw), tz) : null;
    if (!date) return null;
    at = zonedToInstant(addDays(date, -days), step.at ?? WAIT_AT, tz);
  } else if (step.at) {
    at = zonedToInstant(addDays(zonedToday(now, tz), days), step.at, tz);
    // Today at a time already gone: tomorrow at that time.
    if (days === 0 && at.getTime() <= now.getTime()) at = zonedToInstant(addDays(zonedToday(now, tz), 1), step.at, tz);
  } else at = new Date(now.getTime() + days * 86_400_000);
  const cap = new Date(now.getTime() + FLOW_LIMITS.waitDays * 86_400_000);
  return at.getTime() > cap.getTime() ? cap : at;
}

/** "Thu 27 Nov, 09:00". Pure. */
export function whenWords(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${dayWords(p.date)}, ${p.time}`;
}

// ---------- where a run is ----------

/** One branch on the way down: the step's index in its list, then "yes", "no" or a choice's number. */
export type Turn = [index: number, branch: "yes" | "no" | number];
/** A run's place: a stack of lists, each with the next step to run. The root list's path is []. */
export interface Frame {
  path: Turn[];
  i: number;
}

/** The list of steps a path leads to, or null when the flow changed under it. Pure. */
export function listAt(steps: FlowStep[], path: Turn[]): FlowStep[] | null {
  let list: FlowStep[] = steps;
  for (const [i, b] of path) {
    const s = list[i];
    if (!s) return null;
    if (s.kind === "check" && (b === "yes" || b === "no")) list = s[b];
    else if (s.kind === "ask" && typeof b === "number" && s.choices[b]) list = s.choices[b].steps;
    else return null;
  }
  return list;
}

/** Every step, branches included, depth first, with how deep it sits (1 at the top). Pure. */
export function eachStep(steps: FlowStep[], fn: (s: FlowStep, depth: number) => void, depth = 1): void {
  for (const s of steps) {
    fn(s, depth);
    if (s.kind === "check") {
      eachStep(s.yes, fn, depth + 1);
      eachStep(s.no, fn, depth + 1);
    } else if (s.kind === "ask") for (const c of s.choices) eachStep(c.steps, fn, depth + 1);
  }
}

/** Every step in these lists, nested ones too. Pure. */
export function allSteps(steps: FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  eachStep(steps, (s) => void out.push(s));
  return out;
}

export function findStep(steps: FlowStep[], id: string): FlowStep | null {
  return allSteps(steps).find((s) => s.id === id) ?? null;
}

/** How deep branches go: 1 for a flat flow. Pure. */
export function depthOf(steps: FlowStep[]): number {
  let max = 0;
  eachStep(steps, (_s, d) => void (max = Math.max(max, d)));
  return max;
}

/** What every value is called, by "from.key": the trigger's and each step's. Pure. */
export function valueLabels(triggerGives: FlowValue[], steps: FlowStep[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of triggerGives) m.set(`trigger.${g.key}`, g.label);
  for (const s of allSteps(steps)) if ((s.kind === "tool" || s.kind === "think") && Array.isArray(s.gives)) for (const g of s.gives) m.set(`${s.id}.${g.key}`, g.label);
  if (!m.has("trigger.title")) m.set("trigger.title", "its title");
  return m;
}

// ---------- words ----------

export const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
};

/** "Add a to-do: Decide on the renewal". What a change waiting for Go will do. Pure. */
export function pendingWords(label: string, input: Record<string, unknown>): string {
  const main = ["title", "text", "item", "name", "summary", "value", "query"].map((k) => input[k]).find((x): x is string => typeof x === "string" && !!x.trim());
  return main ? `${label}: ${clip(main, 120)}` : label;
}

/** "add a to-do: …" for "Would add a to-do: …". Pure. */
export const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A skipped branch's steps: "Not run: it's on the “Otherwise” path". Pure. */
export function notThisTime(branch: "yes" | "no" | string): string {
  if (branch === "yes") return "Not run: it's on the “If so” path";
  if (branch === "no") return "Not run: it's on the “Otherwise” path";
  return `Not run: you chose “${clip(branch, 40)}”`;
}

/** Where the run stopped for a value nobody gave: "Stopped here: nothing for the company". Pure. */
export const missingLine = (label: string): string => `Stopped here: nothing was found for ${label}`;
