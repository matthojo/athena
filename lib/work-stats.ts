/**
 * The Work page's numbers (#/work, GET /api/life/work), from the owner's own
 * issues and pull requests as the work sync stored them (lib/work.ts). Pure:
 * the server (lib/work-data.ts), the app's sample mode and Ask's `work` tool
 * all call these with the same rules.
 *
 *  - A period: this month, this quarter or this year so far, or an earlier
 *    year. Each is set against the same span before it ("so far" against the
 *    same number of days).
 *  - Shipped on a day: issues completed plus pull requests merged that day,
 *    in the owner's time zone. Cancelled issues don't count.
 *  - Cycle time: an issue's start to its completion. Open to merge: a PR's
 *    opening to its merge. Each as a median and a few plain buckets.
 */
import type { WorkIssue, WorkItem, WorkPr } from "./work";

export type WorkPeriodKind = "month" | "quarter" | "year" | "past";

export interface WorkPeriod {
  id: string;
  kind: WorkPeriodKind;
  label: string;
  from: string;
  to: string;
}

export interface WorkCount {
  issues_closed: number;
  prs_merged: number;
}

export interface WorkHeatDay {
  date: string;
  count: number;
  /** After today: an empty slot. */
  ahead?: boolean;
}

export interface WorkProject {
  name: string;
  issues_closed: number;
  points: number;
}

export interface WorkSpread {
  n: number;
  /** Days (cycle time) or hours (open to merge). */
  median: number;
  buckets: Array<{ label: string; count: number }>;
}

/** A Work activity note, as the page shows it: what shipped, what was decided, what's stuck. */
export interface WorkNote {
  id: string;
  title: string;
  kind: "shipped" | "decided" | "stuck";
  /** A blocker not yet marked cleared. */
  open: boolean;
  date: string;
}

export interface WorkData {
  today: string;
  period: WorkPeriod;
  periods: Array<Pick<WorkPeriod, "id" | "label">>;
  has_work: boolean;
  /** Sources with anything stored, or connected and counted. */
  sources: { linear: boolean; github: boolean };
  count: WorkCount;
  previous: (WorkCount & { label: string }) | null;
  /** Days with something shipped in the period. */
  days: number;
  heat: { label: string; days: WorkHeatDay[]; max: number; shipped_days: number };
  projects: WorkProject[];
  cycle: WorkSpread | null;
  merge: WorkSpread | null;
  /** Only when GitHub is connected or has PRs. */
  /** merged: the owner's own PRs merged; merged_for_others: other people's PRs the owner merged. */
  code: { opened: number; merged: number; merged_for_others: number; reviewed: number; open_now: number; repos: Array<{ repo: string; merged: number }> } | null;
  notes: WorkNote[];
}

export interface WorkProjectDetail {
  name: string;
  issues_closed: number;
  points: number;
  first: string | null;
  last: string | null;
  cycle: WorkSpread | null;
  /** The last 12 months, oldest first. */
  months: Array<{ from: string; count: number }>;
  /** Open first, then the latest closed. Titles of the owner's own issues only. */
  issues: Array<{ id: string; identifier?: string; title: string; url?: string; state?: string; closed?: string }>;
  /** Athena's own project of that name, when there is one. */
  project_id?: string;
}

// ---------- Days ----------

const fmt = new Map<string, Intl.DateTimeFormat>();
/** The owner's local day of an instant. */
export function dayOf(iso: string, tz: string): string {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmt.set(tz, f);
  }
  return f.format(new Date(iso));
}

const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
export const addDay = (d: string, n: number) => new Date(noon(d) + n * 86_400_000).toISOString().slice(0, 10);
const spanDays = (from: string, to: string) => Math.round((noon(to) - noon(from)) / 86_400_000);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthsBack = (d: string, n: number) => {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 - n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
};
const monthEnd = (d: string) => addDay(monthsBack(d, -1), -1);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthWord = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1];
const quarterStart = (d: string) => `${d.slice(0, 4)}-${String(Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;

// ---------- What counts ----------

const isIssue = (i: WorkItem): i is WorkIssue => i.source === "linear";
const isPr = (i: WorkItem): i is WorkPr => i.source === "github";
/** Completed, not cancelled. */
const closedAt = (i: WorkIssue) => (i.completed && !i.canceled && i.state_type !== "canceled" ? i.completed : undefined);
const mergedAt = (p: WorkPr) => (p.role === "opened" ? p.merged : undefined);

/** Each local day's shipped count: issues closed plus PRs merged. */
export function shippedByDay(items: WorkItem[], tz: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) {
    const at = isIssue(i) ? closedAt(i) : isPr(i) ? mergedAt(i) : undefined;
    if (!at) continue;
    const d = dayOf(at, tz);
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

function countIn(items: WorkItem[], from: string, to: string, tz: string): WorkCount {
  const n: WorkCount = { issues_closed: 0, prs_merged: 0 };
  for (const i of items) {
    if (isIssue(i)) {
      const at = closedAt(i);
      if (at && between(dayOf(at, tz), from, to)) n.issues_closed++;
    } else if (isPr(i)) {
      const at = mergedAt(i);
      if (at && between(dayOf(at, tz), from, to)) n.prs_merged++;
    }
  }
  return n;
}

const between = (d: string, from: string, to: string) => d >= from && d <= to;

// ---------- Periods ----------

/** The periods to choose from: this month, quarter and year, and each earlier year that has work. */
export function workPeriods(items: WorkItem[], today: string, tz: string): WorkPeriod[] {
  const year = today.slice(0, 4);
  const out: WorkPeriod[] = [
    { id: "month", kind: "month", label: "This month", from: monthStart(today), to: today },
    { id: "quarter", kind: "quarter", label: "This quarter", from: quarterStart(today), to: today },
    { id: "year", kind: "year", label: "This year", from: `${year}-01-01`, to: today },
  ];
  const years = new Set<string>();
  for (const [d] of shippedByDay(items, tz)) if (d.slice(0, 4) < year) years.add(d.slice(0, 4));
  for (const y of [...years].sort().reverse()) out.push({ id: y, kind: "past", label: y, from: `${y}-01-01`, to: `${y}-12-31` });
  return out;
}

/** The same span before: the previous month, quarter or year, cut to as many days as this one has had. */
export function previousSpan(p: WorkPeriod): { from: string; to: string; label: string } {
  if (p.kind === "past") {
    const y = String(Number(p.id) - 1);
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: y };
  }
  const back = p.kind === "month" ? 1 : p.kind === "quarter" ? 3 : 12;
  const from = monthsBack(p.from, back);
  const end = monthEnd(monthsBack(p.from, 1));
  const to = [addDay(from, spanDays(p.from, p.to)), end].sort()[0];
  const label = p.kind === "month" ? monthWord(from) : p.kind === "quarter" ? "last quarter" : from.slice(0, 4);
  return { from, to, label };
}

// ---------- Spreads ----------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const CYCLE_BUCKETS: Array<[string, number]> = [
  ["Under a day", 1],
  ["1 to 3 days", 3],
  ["3 days to a week", 7],
  ["1 to 2 weeks", 14],
  ["2 weeks to a month", 30],
  ["Over a month", Infinity],
];
const MERGE_BUCKETS: Array<[string, number]> = [
  ["Under an hour", 1],
  ["1 to 4 hours", 4],
  ["The same day", 24],
  ["1 to 3 days", 72],
  ["3 days to a week", 168],
  ["Over a week", Infinity],
];

function spread(values: number[], buckets: Array<[string, number]>): WorkSpread | null {
  if (!values.length) return null;
  const counts = buckets.map(([label]) => ({ label, count: 0 }));
  for (const v of values) counts[buckets.findIndex(([, max]) => v < max)].count++;
  return { n: values.length, median: Math.round(median(values) * 10) / 10, buckets: counts };
}

/** Issues closed in the range: start to close, in days. Issues with no start time are left out. */
export function cycleTimes(items: WorkItem[], from: string, to: string, tz: string): WorkSpread | null {
  const days = items
    .filter(isIssue)
    .flatMap((i) => {
      const end = closedAt(i);
      if (!end || !i.started || !between(dayOf(end, tz), from, to)) return [];
      const d = (Date.parse(end) - Date.parse(i.started)) / 86_400_000;
      return d >= 0 ? [d] : [];
    });
  return spread(days, CYCLE_BUCKETS);
}

/** PRs merged in the range: open to merge, in hours. */
export function mergeTimes(items: WorkItem[], from: string, to: string, tz: string): WorkSpread | null {
  const hours = items
    .filter(isPr)
    .flatMap((p) => {
      const end = mergedAt(p);
      if (!end || !p.opened || !between(dayOf(end, tz), from, to)) return [];
      const h = (Date.parse(end) - Date.parse(p.opened)) / 3_600_000;
      return h >= 0 ? [h] : [];
    });
  return spread(hours, MERGE_BUCKETS);
}

// ---------- The year of days ----------

/** Monday on or before the day. */
const mondayOf = (d: string) => addDay(d, -((new Date(noon(d)).getUTCDay() + 6) % 7));

/** A year of days, whole weeks Monday to Sunday: the 53 weeks to this one, or a past year's own. */
export function heatYear(items: WorkItem[], p: WorkPeriod, today: string, tz: string): WorkData["heat"] {
  const end = p.kind === "past" ? p.to : today;
  const start = p.kind === "past" ? mondayOf(p.from) : mondayOf(addDay(today, -364));
  const last = addDay(mondayOf(end), 6);
  const by = shippedByDay(items, tz);
  const days: WorkHeatDay[] = [];
  let max = 0;
  let shipped = 0;
  for (let d = start; d <= last; d = addDay(d, 1)) {
    const outside = d > today || (p.kind === "past" && (d < p.from || d > p.to));
    const count = outside ? 0 : (by.get(d) ?? 0);
    if (count) shipped++;
    max = Math.max(max, count);
    days.push({ date: d, count, ...(outside ? { ahead: true } : {}) });
  }
  return { label: p.kind === "past" ? `Days you shipped in ${p.label}` : "Days you shipped, the last year", days, max, shipped_days: shipped };
}

// ---------- Projects ----------

const NO_PROJECT = "No project";

export function projectsIn(items: WorkItem[], from: string, to: string, tz: string): WorkProject[] {
  const by = new Map<string, WorkProject>();
  for (const i of items.filter(isIssue)) {
    const at = closedAt(i);
    if (!at || !between(dayOf(at, tz), from, to)) continue;
    const name = i.project ?? NO_PROJECT;
    const p = by.get(name) ?? { name, issues_closed: 0, points: 0 };
    p.issues_closed++;
    p.points += i.estimate ?? 0;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => b.issues_closed - a.issues_closed || b.points - a.points || a.name.localeCompare(b.name));
}

// ---------- The page ----------

/** Open blockers first, then everything newest first. */
export function orderNotes(notes: WorkNote[]): WorkNote[] {
  return [...notes].sort((a, b) => Number(b.kind === "stuck" && b.open) - Number(a.kind === "stuck" && a.open) || b.date.localeCompare(a.date));
}

export function workPage(input: { items: WorkItem[]; notes: WorkNote[]; today: string; tz: string; period?: string | null; connected?: { linear?: boolean; github?: boolean } }): WorkData {
  const { items, today, tz } = input;
  const periods = workPeriods(items, today, tz);
  const period = periods.find((p) => p.id === input.period) ?? periods[0];
  const count = countIn(items, period.from, period.to, tz);
  const prev = previousSpan(period);
  const before = countIn(items, prev.from, prev.to, tz);
  const prs = items.filter(isPr);
  const github = !!input.connected?.github || prs.length > 0;
  const by = shippedByDay(items, tz);
  // A comparison only once there's history reaching back that far.
  const anyBefore = [...by.keys()].some((d) => d <= prev.to);
  const shippedDays = [...by.keys()].filter((d) => between(d, period.from, period.to)).length;
  const inRange = (at?: string) => !!at && between(dayOf(at, tz), period.from, period.to);
  const repos = new Map<string, number>();
  for (const p of prs) if (inRange(mergedAt(p))) repos.set(p.repo, (repos.get(p.repo) ?? 0) + 1);
  return {
    today,
    period,
    periods: periods.map(({ id, label }) => ({ id, label })),
    has_work: items.length > 0,
    sources: { linear: !!input.connected?.linear || items.some(isIssue), github },
    count,
    previous: anyBefore ? { ...before, label: prev.label } : null,
    days: shippedDays,
    heat: heatYear(items, period, today, tz),
    projects: projectsIn(items, period.from, period.to, tz),
    cycle: cycleTimes(items, period.from, period.to, tz),
    merge: mergeTimes(items, period.from, period.to, tz),
    code: github
      ? {
          opened: prs.filter((p) => p.role === "opened" && inRange(p.opened)).length,
          merged: count.prs_merged,
          merged_for_others: prs.filter((p) => p.role === "merged" && inRange(p.merged)).length,
          reviewed: prs.filter((p) => p.role === "reviewed" && inRange(p.reviewed_at)).length,
          open_now: prs.filter((p) => p.role === "opened" && !p.merged && !p.closed).length,
          repos: [...repos.entries()].map(([repo, merged]) => ({ repo, merged })).sort((a, b) => b.merged - a.merged || a.repo.localeCompare(b.repo)).slice(0, 6),
        }
      : null,
    notes: orderNotes(input.notes),
  };
}

/** One project over the last year: what the sheet shows. Null when nothing of the owner's is in it. */
export function projectDetail(items: WorkItem[], name: string, today: string, tz: string): WorkProjectDetail | null {
  const mine = items.filter(isIssue).filter((i) => (i.project ?? NO_PROJECT) === name);
  if (!mine.length) return null;
  const closed = mine.filter((i) => closedAt(i)).sort((a, b) => closedAt(b)!.localeCompare(closedAt(a)!));
  const first = closed.length ? dayOf(closedAt(closed[closed.length - 1])!, tz) : null;
  const last = closed.length ? dayOf(closedAt(closed[0])!, tz) : null;
  const months = Array.from({ length: 12 }, (_, k) => monthsBack(today, 11 - k)).map((from) => ({ from, count: closed.filter((i) => dayOf(closedAt(i)!, tz).slice(0, 7) === from.slice(0, 7)).length }));
  const open = mine.filter((i) => !closedAt(i) && !i.canceled).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  return {
    name,
    issues_closed: closed.length,
    points: closed.reduce((s, i) => s + (i.estimate ?? 0), 0),
    first,
    last,
    cycle: cycleTimes(mine, "0000-01-01", "9999-12-31", tz),
    months,
    issues: [...open.slice(0, 10), ...closed.slice(0, 20)].map((i) => ({ id: i.id, ...(i.identifier ? { identifier: i.identifier } : {}), title: i.title, ...(i.url ? { url: i.url } : {}), ...(i.state ? { state: i.state } : {}), ...(closedAt(i) ? { closed: dayOf(closedAt(i)!, tz) } : {}) })),
  };
}

/** A Work activity note's kind, from its tags and words. */
export function noteKind(note: { title: string; tags?: string[]; body?: string }): WorkNote["kind"] {
  const tags = (note.tags ?? []).map((t) => t.toLowerCase());
  const words = `${note.title} ${note.body ?? ""}`.toLowerCase();
  if (tags.some((t) => t === "blocked" || t === "blocker" || t === "stuck") || /\b(blocked|blocker|stuck|waiting on)\b/.test(note.title.toLowerCase())) return "stuck";
  if (tags.some((t) => t === "decision" || t === "decided") || /\b(decided|decision|agreed)\b/.test(words.slice(0, 200))) return "decided";
  return "shipped";
}

/** A blocker is open until a tag or its words say it's cleared. */
export function noteOpen(note: { title: string; tags?: string[]; body?: string }): boolean {
  const tags = (note.tags ?? []).map((t) => t.toLowerCase());
  if (tags.some((t) => ["unblocked", "resolved", "cleared", "done"].includes(t))) return false;
  return !/\b(unblocked|resolved|cleared|no longer blocked)\b/i.test(`${note.title} ${note.body ?? ""}`);
}
