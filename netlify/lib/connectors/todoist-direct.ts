/**
 * Todoist without MCP, for routines: a narrow, read-only adapter over the
 * Todoist API v1 (api.todoist.com/api/v1), registered in direct.ts. Used
 * when a Todoist account is added with a personal API token (Todoist →
 * Settings → Integrations → Developer) instead of signing in to the hosted
 * MCP server; both feed the Life log's habits the same way.
 *
 * completed_tasks: /tasks/completed/by_completion_date (since, until). A
 * recurring task's completion isn't there (the task stays open), so
 * completed_events reads /activities (object_type item, event_type
 * completed) too. routines_on(date) joins the two into the day's habits:
 * recurring tasks and tasks labelled habit, each done once a day.
 *
 * Refusals: a bad token is a 401 with error_tag AUTH_INVALID_TOKEN
 * (recorded 7 Nov 2026), which the account shows as needs_auth.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { addDays, zonedToInstant } from "../../../lib/dates";
import { ToolInputError, arg, clean } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { CURSOR_PROP, LifeApiError, WINDOW_PROPS, account, getJson, lifeAccountProblem, lifeFailure, ownerZone, readOnly, when, windowOf, withItems, type LifeTool } from "./lifelog-b-http";
import { todoistRecent } from "./activity-recent";

export const TODOIST_API_URL = "https://api.todoist.com/api/v1";
const HOSTS = ["api.todoist.com"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("todoist", 401, "Todoist didn't accept that token. Copy it again from Todoist → Settings → Integrations → Developer, and paste it under Edit.", true);
  if (status === 429) return new LifeApiError("todoist", 429, "Todoist is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("todoist", status, "Todoist is having trouble right now. Try again in a few minutes.");
  if (status === 400) return new LifeApiError("todoist", 400, "Todoist didn't understand those dates");
  return new LifeApiError("todoist", status, `Todoist refused that (${status})`);
}

export interface TodoistContext {
  get<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  tz: string;
}

interface RawTask {
  id?: string;
  task_id?: string;
  content?: string;
  completed_at?: string;
  labels?: string[];
  due?: { is_recurring?: boolean } | null;
}

interface RawEvent {
  object_id?: string;
  event_type?: string;
  event_date?: string;
  extra_data?: { content?: string; is_recurring?: boolean } | null;
}

const isHabit = (labels: string[] | undefined) => (labels ?? []).some((l) => l.toLowerCase() === "habit" || l.toLowerCase() === "habits");

/** The window as ISO times; default the last 7 days. */
function range(args: Record<string, unknown>, tz: string): { since: string; until: string } {
  const w = windowOf(args, tz);
  const until = w.before ?? Date.now();
  const since = w.after ?? until - 7 * 86_400_000;
  if (until - since > 92 * 86_400_000) throw new ToolInputError("Ask for 92 days or fewer at a time");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

async function completed(ctx: TodoistContext, since: string, until: string, cursor?: string) {
  const body = await ctx.get<{ items?: RawTask[]; next_cursor?: string | null }>("/tasks/completed/by_completion_date", { since, until, limit: "200", cursor });
  return { items: body.items ?? [], next: body.next_cursor || undefined };
}

async function events(ctx: TodoistContext, since: string, until: string, cursor?: string) {
  const body = await ctx.get<{ results?: RawEvent[]; next_cursor?: string | null }>("/activities", { object_type: "item", event_type: "completed", date_from: since, date_to: until, limit: "100", cursor });
  return { items: (body.results ?? []).filter((e) => !e.event_type || e.event_type === "completed"), next: body.next_cursor || undefined };
}

/** One local day's routines: recurring tasks and tasks labelled habit that were completed, once each. */
export async function routinesOn(ctx: TodoistContext, date: string) {
  if (!DAY.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
  const since = zonedToInstant(date, "00:00", ctx.tz).toISOString();
  const until = zonedToInstant(addDays(date, 1), "00:00", ctx.tz).toISOString();
  const out = new Map<string, { task_id: string; name: string; at?: string; recurring: boolean }>();
  let cursor: string | undefined;
  for (let n = 0; n < 5; n++) {
    const page = await completed(ctx, since, until, cursor);
    for (const t of page.items) {
      const id = t.task_id ?? t.id;
      if (!id || !t.content || !(t.due?.is_recurring || isHabit(t.labels))) continue;
      out.set(id, { task_id: id, name: t.content.trim(), at: t.completed_at, recurring: !!t.due?.is_recurring });
    }
    if (!(cursor = page.next)) break;
  }
  cursor = undefined;
  for (let n = 0; n < 5; n++) {
    const page = await events(ctx, since, until, cursor);
    for (const e of page.items) {
      // Recurring completions are only here; a one-off task's completion is already in the list above.
      if (!e.object_id || out.has(e.object_id) || !e.extra_data?.content || e.extra_data.is_recurring === false) continue;
      out.set(e.object_id, { task_id: e.object_id, name: e.extra_data.content.trim(), at: e.event_date, recurring: true });
    }
    if (!(cursor = page.next)) break;
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => clean({ date, ...r, done: true }));
}

export const TODOIST_TOOLS: LifeTool<TodoistContext>[] = [
  {
    name: "routines_on",
    summary: "See a day's routines",
    description:
      'The routines finished on one local day: recurring tasks and tasks labelled habit, each once, with task_id, name, at and recurring. Write each as a habit entry: title = name, count 1, external_id = "<task_id>:<date>", group "habits", source todoist. Todoist can\'t say what was missed.',
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    async run(ctx, args) {
      return withItems(await routinesOn(ctx, arg.str(args, "date", { required: true })!), {});
    },
  },
  {
    name: "completed_tasks",
    summary: "See finished tasks",
    description: "Tasks finished in a window, newest first: task_id, name, at (local date and time), labels, recurring. Recurring tasks' completions are in completed_events instead. Default: the last 7 days.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, ...CURSOR_PROP } },
    annotations: readOnly,
    async run(ctx, args) {
      const { since, until } = range(args, ctx.tz);
      const page = await completed(ctx, since, until, arg.str(args, "cursor", { max: 500 }));
      const items = page.items.map((t) => clean({ task_id: t.task_id ?? t.id, name: t.content, ...(t.completed_at ? when(Date.parse(t.completed_at), ctx.tz) : {}), labels: t.labels, recurring: t.due?.is_recurring || undefined }));
      return withItems(items, { next_cursor: page.next });
    },
  },
  {
    name: "completed_events",
    summary: "See completions in your activity",
    description: "Task completions from your activity log in a window, recurring ones included: task_id, name, at (local). Default: the last 7 days.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, ...CURSOR_PROP } },
    annotations: readOnly,
    async run(ctx, args) {
      const { since, until } = range(args, ctx.tz);
      const page = await events(ctx, since, until, arg.str(args, "cursor", { max: 500 }));
      const items = page.items.map((e) => clean({ task_id: e.object_id, name: e.extra_data?.content, ...(e.event_date ? when(Date.parse(e.event_date), ctx.tz) : {}) }));
      return withItems(items, { next_cursor: page.next });
    },
  },
];

/** Open with the token: one cheap read (the last day's completions) proves it works. */
export async function openTodoist(_connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("todoist", 401, "Paste your Todoist API token.", true);
  const get = <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`${TODOIST_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    return getJson<T>(url.toString(), { service: "todoist", hosts: HOSTS, headers: { Authorization: `Bearer ${token}` }, refused, unreachable: "Couldn't reach Todoist" });
  };
  const now = Date.now();
  await get("/tasks/completed/by_completion_date", { since: new Date(now - 86_400_000).toISOString(), until: new Date(now).toISOString(), limit: "1" });
  return account("todoist", TODOIST_TOOLS, { get, tz: tz ?? (await ownerZone()) });
}

export const todoistAdapter: DirectAdapter = {
  id: "todoist",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: todoistRecent,
  handles: (c) => c.provider === "todoist" && c.auth_type === "token",
  tools: () => TODOIST_TOOLS,
  serverInfo: () => ({ website_url: "https://todoist.com/" }),
  open: (connector, secrets) => openTodoist(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("todoist", e),
  failure: (e) => lifeFailure("todoist", e),
};
