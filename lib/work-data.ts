/**
 * The rows behind the Work page (#/work) on the server, for GET /api/life/work:
 * the owner's own issues and PRs (lib/work.ts) and the Work activity
 * collection's notes, shaped by lib/work-stats.ts. Ask's `work` tool reads the
 * same.
 */
import { q } from "./db";
import { listConnectors } from "./connectors";
import { readWorkItems, type WorkItem } from "./work";
import { dayOf, noteKind, noteOpen, projectDetail, workPage, type WorkData, type WorkNote, type WorkProjectDetail } from "./work-stats";

/** Work activity's notes in the last 90 days: what shipped, what was decided, what's stuck. */
export async function workNotes(tz: string, limit = 40): Promise<WorkNote[]> {
  const rows = await q<{ id: string; title: string; body: string; tags: string[]; created_at: string }>(
    `SELECT id, title, body, tags, created_at FROM notes
     WHERE archived_at IS NULL AND (source = 'work-activity' OR source LIKE 'work-activity-%') AND created_at > now() - interval '90 days'
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((n) => {
    const kind = noteKind(n);
    return { id: n.id, title: n.title, kind, open: kind === "stuck" && noteOpen(n), date: dayOf(n.created_at, tz) };
  });
}

/** Which work accounts are connected, so Code shows before the first PR arrives. */
async function connected(): Promise<{ linear: boolean; github: boolean }> {
  const all = await listConnectors().catch(() => []);
  const on = (p: string) => all.some((c) => c.provider === p && c.status !== "needs_auth");
  return { linear: on("linear"), github: on("github") };
}

export async function workData(period: string | null, today: string, tz: string, opts: { items?: WorkItem[] } = {}): Promise<WorkData> {
  const [items, notes, sources] = await Promise.all([opts.items ? Promise.resolve(opts.items) : readWorkItems().then((r) => r.items), workNotes(tz), connected()]);
  return workPage({ items, notes, today, tz, period, connected: sources });
}

/** One project: its sheet, with Athena's own project of the same name when there is one. */
export async function workProject(name: string, today: string, tz: string): Promise<WorkProjectDetail | null> {
  const { items } = await readWorkItems({ source: "linear" });
  const p = projectDetail(items, name, today, tz);
  if (!p) return null;
  const [own] = await q<{ id: string }>(`SELECT id FROM projects WHERE lower(name) = lower($1) AND archived_at IS NULL LIMIT 1`, [name]).catch(() => []);
  return own ? { ...p, project_id: own.id } : p;
}
