/**
 * Habitify without MCP: a narrow, read-only adapter over Habitify's public
 * API (api.habitify.me), registered in direct.ts. The owner pastes the API
 * key from Habitify → Settings → API key; it goes in the X-API-Key header
 * (Habitify's v2 OpenAPI, checked 7 Nov 2026). API access needs Habitify's
 * paid plan; the limit is 500 requests a minute.
 *
 * habits_on(date): each habit's status for one local day, from the journal.
 * The journal leaves bad habits out (a known Habitify bug: feedback.habitify.me
 * "get v2/habits/journal does not return bad habits"), so the habit list is
 * read too and the gaps filled from each missing habit's logs for the day.
 *
 * habit_logs(habit, after, before): one habit's logged values, for counted
 * goals ("3 of 5 glasses") and backfill.
 *
 * Habits aren't sealed: the Life log writes each as a `habit` entry
 * (lib/day-types.ts): title = the habit, count 1 done or 0 not, note
 * "skipped" or "3 of 5 glasses".
 */
import { HABITIFY_API_URL } from "../../../lib/presets/life";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { zonedParts } from "../../../lib/dates";
import { ToolInputError, arg, clean } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { CURSOR_PROP, LifeApiError, WINDOW_PROPS, account, getJson, inWindow, lifeAccountProblem, lifeFailure, ownerZone, readOnly, when, windowOf, withItems, type LifeTool } from "./lifelog-b-http";
import { habitifyRecent } from "./activity-recent";

const HOSTS = ["api.habitify.me"];
const BAD_KEY = "Habitify didn't accept that API key. Copy it again from Habitify → Settings → API key, and paste it under Edit.";

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("habitify", 401, BAD_KEY, true);
  if (status === 404) return new LifeApiError("habitify", 404, "Habitify can't find that habit");
  if (status === 429) return new LifeApiError("habitify", 429, "Habitify is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("habitify", status, "Habitify is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("habitify", status, `Habitify refused that (${status})`);
}

export interface HabitifyContext {
  get<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  tz: string;
}

/** A habit as Habitify's journal and habit list give it (fields vary by endpoint version, so read loosely). */
interface RawHabit {
  id?: string;
  name?: string;
  is_archived?: boolean;
  /** "good" or "bad" in v2; older replies say habit_type 1 or 2. */
  type?: string;
  habit_type?: number;
  start_date?: string;
  status?: string | { status?: string };
  goal?: { value?: number; unit_type?: string; periodicity?: string } | null;
  progress?: { current_value?: number; target_value?: number; unit_type?: string } | null;
}

interface RawLog {
  id?: string;
  value?: number;
  created_date?: string;
  unit_type?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type HabitStatus = "done" | "skipped" | "failed" | "none";

export function statusOf(raw: RawHabit["status"]): HabitStatus {
  const s = (typeof raw === "string" ? raw : raw?.status ?? "").toLowerCase();
  if (s === "completed" || s === "done") return "done";
  if (s === "skipped") return "skipped";
  if (s === "failed") return "failed";
  return "none";
}

const isBad = (h: RawHabit): boolean => h.type === "bad" || h.habit_type === 2;

/** Words for a unit: "glasses", "min", "km". Habitify's unit names are short codes. */
const UNIT: Record<string, string> = { rep: "times", reps: "times", count: "times", min: "min", minute: "min", minutes: "min", hr: "hours", hour: "hours", km: "km", m: "m", step: "steps", steps: "steps", cup: "cups", glass: "glasses", ml: "ml", l: "litres", kcal: "kcal", page: "pages", pages: "pages" };
const unitWord = (u: string | undefined): string | undefined => (u ? UNIT[u.toLowerCase()] ?? u.toLowerCase() : undefined);

/** "3 of 5 glasses": only for a counted goal above one. */
export function progressNote(h: RawHabit): string | undefined {
  const target = h.progress?.target_value ?? h.goal?.value;
  const current = h.progress?.current_value;
  if (typeof target !== "number" || target <= 1 || typeof current !== "number") return undefined;
  const unit = unitWord(h.progress?.unit_type ?? h.goal?.unit_type);
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return `${n(current)} of ${n(target)}${unit && unit !== "times" ? ` ${unit}` : ""}`;
}

export interface HabitDay {
  date: string;
  habit_id: string;
  name: string;
  status: HabitStatus;
  /** For a habit entry's count: 1 done, 0 not. */
  done: boolean;
  bad?: boolean;
  note?: string;
}

const list = <T>(body: unknown): T[] => {
  const b = body as { data?: unknown } | unknown[] | null;
  if (Array.isArray(b)) return b as T[];
  if (b && Array.isArray((b as { data?: unknown }).data)) return (b as { data: T[] }).data;
  return [];
};

function dayOf(h: RawHabit, date: string, status: HabitStatus): HabitDay {
  const note = status === "skipped" ? "skipped" : progressNote(h);
  return clean({ date, habit_id: h.id!, name: (h.name ?? "").trim(), status, done: status === "done", bad: isBad(h) || undefined, note }) as HabitDay;
}

/** Every live habit's status on one local day, the journal's gaps filled from the habit list and logs. */
export async function habitsOn(ctx: HabitifyContext, date: string): Promise<HabitDay[]> {
  if (!DAY.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
  const [journal, all] = await Promise.all([ctx.get<unknown>("/v2/habits/journal", { date }), ctx.get<unknown>("/v2/habits")]);
  const seen = new Map<string, HabitDay>();
  for (const h of list<RawHabit>(journal)) {
    if (!h.id || !h.name || h.is_archived) continue;
    seen.set(h.id, dayOf(h, date, statusOf(h.status)));
  }
  for (const h of list<RawHabit>(all)) {
    if (!h.id || !h.name || h.is_archived || seen.has(h.id)) continue;
    if (h.start_date && h.start_date.slice(0, 10) > date) continue;
    // Missing from the journal: a bad habit (Habitify's bug). Logged that day means it happened; nothing logged means it was avoided.
    const logs = list<RawLog>(await ctx.get<unknown>(`/v2/habits/${encodeURIComponent(h.id)}/logs`, { startDate: date, endDate: date, limit: "100" }));
    const status: HabitStatus = isBad(h) ? (logs.length ? "failed" : "done") : logs.length ? "done" : "none";
    seen.set(h.id, dayOf(h, date, status));
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const HABITIFY_TOOLS: LifeTool<HabitifyContext>[] = [
  {
    name: "habits_on",
    summary: "See a day's habits",
    description:
      "Every habit on one local day: habit_id, name, status (done, skipped, failed, none), done (true or false), bad (a habit to avoid: done means avoided), note (\"skipped\", or a counted goal's \"3 of 5 glasses\"). Write each as a habit entry: title = name, count = 1 when done else 0, note as given, external_id = \"<habit_id>:<date>\".",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    async run(ctx, args) {
      return withItems(await habitsOn(ctx, arg.str(args, "date", { required: true })!), {});
    },
  },
  {
    name: "habit_logs",
    summary: "See one habit's history",
    description: "One habit's logs in a window, newest first: date and time (local), value and unit. For a counted goal and for filling in past days. Default: the last 7 days.",
    inputSchema: { type: "object", properties: { habit: { type: "string", description: "The habit_id from habits_on." }, ...WINDOW_PROPS, ...CURSOR_PROP }, required: ["habit"] },
    annotations: readOnly,
    async run(ctx, args) {
      const id = arg.str(args, "habit", { required: true, max: 100 })!;
      const w = windowOf(args, ctx.tz);
      const before = w.before ?? Date.now();
      const after = w.after ?? before - 7 * 86_400_000;
      const from = zonedParts(new Date(after), ctx.tz).date;
      const to = zonedParts(new Date(before - 1), ctx.tz).date;
      const logs = list<RawLog>(await ctx.get<unknown>(`/v2/habits/${encodeURIComponent(id)}/logs`, { startDate: from, endDate: to, limit: "100" }));
      const items = logs
        .map((l) => ({ l, ms: Date.parse(l.created_date ?? "") }))
        .filter(({ ms }) => Number.isFinite(ms) && inWindow(ms, { after, before }))
        .sort((a, b) => b.ms - a.ms)
        .map(({ l, ms }) => clean({ ...when(ms, ctx.tz), value: typeof l.value === "number" ? l.value : undefined, unit: unitWord(l.unit_type) }));
      return withItems(items, {});
    },
  },
];

/** Open with the key: one cheap read (the habit list) proves it works. */
export async function openHabitify(_connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const key = secrets.token?.trim();
  if (!key) throw new LifeApiError("habitify", 401, "Paste your Habitify API key.", true);
  const get = <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`${HABITIFY_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    return getJson<T>(url.toString(), { service: "habitify", hosts: HOSTS, headers: { "X-API-Key": key }, refused, unreachable: "Couldn't reach Habitify" });
  };
  await get("/v2/habits");
  return account("habitify", HABITIFY_TOOLS, { get, tz: tz ?? (await ownerZone()) });
}

export const habitifyAdapter: DirectAdapter = {
  id: "habitify",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: habitifyRecent,
  handles: (c) => c.provider === "habitify" && c.auth_type === "token",
  tools: () => HABITIFY_TOOLS,
  serverInfo: () => ({ website_url: "https://www.habitify.me/" }),
  open: (connector, secrets) => openHabitify(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("habitify", e),
  failure: (e) => lifeFailure("habitify", e),
};
