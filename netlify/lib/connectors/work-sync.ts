/**
 * Your work, counted (owner decision, 12 Nov): a collection with no model.
 * Each run calls the work accounts' own read tools with fixed arguments
 * (callTool, never Claude) and stores only the owner's own activity in
 * work_items (lib/work.ts), sealed:
 *
 *  - Linear: issues assigned to the owner (list_issues, assignee "me"),
 *    checked against the owner's own id (get_user "me"): id, title, project,
 *    team, state, created, started and completed times, estimate.
 *  - GitHub: pull requests the owner opened, and other people's they
 *    reviewed or merged (search_pull_requests), with the owner's login from
 *    get_me: repo, number, title, opened and merged times, and how many
 *    reviews it got (pull_request_read get_reviews, a count, no names), when
 *    the owner first reviewed it, or (pull_request_read get) that the owner
 *    was the one who merged it. Search has no "merged by" filter, so merged
 *    PRs involving the owner are each checked, and kept only when they were.
 *  - Linear's tools say who an issue is assigned to but not who closed it,
 *    so an issue closed by the owner but assigned to someone else isn't
 *    counted: finding one would mean reading the whole team's issues.
 *
 * Nothing about anyone else is stored: work-parse.ts drops a teammate's
 * issue and a PR's author before saving. Ask reads other people's work live
 * from the same accounts and keeps nothing (lib/answer.ts).
 *
 * As Plays and watches does (media-sync.ts):
 *  - State per account in settings (`work_sync.<id>`): the newest change
 *    seen, a read left part-way (the page to carry on from), a lease and a
 *    wait. Times and cursors only.
 *  - Each run reads from the start of yesterday or two hours before the
 *    newest change seen, whichever is earlier, so an issue closed late or a
 *    review that arrived after the PR changed is still counted. The first run
 *    reads back a year; what doesn't fit is carried on next run.
 *  - Only the reads the owner allows under "What Athena can read".
 *  - A 429 waits an hour, a 5xx 15 minutes; a reply in a shape Athena
 *    doesn't know fails the account with a plain error and stores nothing.
 *
 * Titles and ids are never logged.
 */
import { getConnector, listCollections, type Collection, type Connector, type RunStatsJson } from "../../../lib/connectors";
import { getOwnerTimeZone, qRaw } from "../../../lib/db";
import { addDays, zonedToInstant, zonedToday } from "../../../lib/dates";
import { readWorkItems, saveWorkItems, workKey, type WorkItem, type WorkPr } from "../../../lib/work";
import { callTool, ConnectorNeedsSignIn, openConnector, type OpenConnector } from "./mcp-client";
import { waitAfter } from "./media-sync";
import { githubMe, githubMergedBy, githubPrs, githubReviews, linearIssues, linearMe, ShapeUnknown } from "./work-parse";

export const RECIPE = "work-sync";
/** The accounts it reads. */
export const WORK_PROVIDERS = ["linear", "github"] as const;
/** The reads each needs (all of `needs`; `extra` adds review counts). */
export const WORK_TOOLS: Record<(typeof WORK_PROVIDERS)[number], { needs: string[]; extra: string[] }> = {
  linear: { needs: ["get_user", "list_issues"], extra: [] },
  github: { needs: ["get_me", "search_pull_requests"], extra: ["pull_request_read"] },
};
/** How far before the newest change a read starts. */
export const OVERLAP_MS = 2 * 60 * 60_000;
/** The first run reads back this far. */
export const FIRST_DAYS = 365;
/** Pages one stream reads in a run. */
export const MAX_PAGES = 10;
export const PAGE_SIZE = 50;
/** Review lookups in one run, across the account's PRs. */
export const MAX_REVIEW_READS = 60;
/** Each account's share of a run. */
export const PER_ACCOUNT_MS = 2 * 60_000;

type Provider = (typeof WORK_PROVIDERS)[number];
const isWork = (p: string): p is Provider => (WORK_PROVIDERS as readonly string[]).includes(p);

/** A read left part-way: where it started and the page to carry on from. */
interface Pending {
  since: string;
  /** Linear's cursor, or GitHub's next page number. */
  at: string;
}

export interface StreamState {
  /** The newest change seen (ISO). */
  last?: string;
  pending?: Pending;
  /** Merged: PRs checked and found merged by someone else, as a hash of the id → its updated time, so they aren't asked about again until they change. */
  not_mine?: Record<string, string>;
}

/** Stored as settings `work_sync.<connector id>`. */
export interface WorkSyncState {
  streams?: Record<string, StreamState>;
  last_at?: string;
  resume_at?: string;
  lease_until?: string;
  error?: string;
}

const KEY = (id: string) => `work_sync.${id}`;

export async function getWorkSync(connectorId: string): Promise<WorkSyncState | null> {
  const [row] = await qRaw<{ value: WorkSyncState }>(`SELECT value FROM settings WHERE key = $1`, [KEY(connectorId)]);
  return row?.value ?? null;
}

async function patchState(connectorId: string, patch: Partial<WorkSyncState>): Promise<void> {
  const clear = Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = (settings.value || EXCLUDED.value) - $3::text[], updated_at = now()`,
    [KEY(connectorId), JSON.stringify(patch), clear],
  );
}

async function claim(connectorId: string, until: string, nowIso: string): Promise<boolean> {
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`, [KEY(connectorId)]);
  const rows = await qRaw<{ key: string }>(
    `UPDATE settings SET value = jsonb_set(value, '{lease_until}', to_jsonb($2::text)), updated_at = now()
     WHERE key = $1 AND COALESCE(value->>'lease_until', '') < $3 AND COALESCE(value->>'resume_at', '') <= $3
     RETURNING key`,
    [KEY(connectorId), until, nowIso],
  );
  return rows.length > 0;
}

/**
 * What a stream reads this run: first a read left part-way (carried on from
 * its page), then the recent changes, from two hours before the newest one
 * seen or the start of yesterday, whichever is earlier (the late re-read). The
 * first run reads back FIRST_DAYS.
 */
export function readPlan(st: StreamState, nowMs: number, yesterdayMs: number): Array<{ since: string; at?: string; carry: boolean }> {
  const from = st.last ? Math.min(Date.parse(st.last) - OVERLAP_MS, yesterdayMs) : nowMs - FIRST_DAYS * 86_400_000;
  return [...(st.pending ? [{ since: st.pending.since, at: st.pending.at, carry: true }] : []), { since: new Date(from).toISOString(), carry: false }];
}

/** Is this an account the work sync reads? */
export function countsWork(connector: Pick<Connector, "provider">): boolean {
  return isWork(connector.provider);
}

/** Does the owner allow the reads it needs? */
export function allowsWork(connector: Pick<Connector, "provider" | "allowed_tools">): boolean {
  if (!isWork(connector.provider)) return false;
  const allowed = new Set(connector.allowed_tools ?? []);
  return WORK_TOOLS[connector.provider].needs.every((t) => allowed.has(t));
}

/** Is it switched on: in an enabled Your work, counted collection. */
export function workSyncOn(connectorId: string, collections: Collection[]): boolean {
  return collections.some((c) => c.recipe === RECIPE && c.enabled && c.connector_ids.includes(connectorId));
}

/** How accounts are opened: the MCP client's, unless a test swaps it (at the MCP client: callTool still runs). */
let opener: (id: string) => Promise<OpenConnector> = openConnector;
export function useWorkOpener(open: ((id: string) => Promise<OpenConnector>) | null): void {
  opener = open ?? openConnector;
}

export interface WorkSyncOptions {
  budgetMs: number;
  clock?: () => number;
  /** Tests: how the account is opened and called (the MCP client's by default). */
  open?: (id: string) => Promise<OpenConnector>;
  call?: (open: OpenConnector, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

export interface WorkSyncResult {
  /** failed: a reply Athena didn't recognise; blocked: the owner has a step to take. */
  state: "checked" | "waiting" | "off" | "busy" | "blocked" | "failed";
  issues: number;
  prs: number;
  updated: number;
  read: number;
  message?: string;
  resume_at?: string;
}

/** A tool's error reply, as an error waitAfter understands. */
function toolError(text: string): Error & { status?: number } {
  const e = new Error("The account's tool answered with an error") as Error & { status?: number };
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) e.status = 429;
  else if (/unauthori[sz]ed|\b401\b|bad credentials|invalid token/i.test(text)) e.status = 401;
  else if (/\b5\d\d\b|unavailable|timed? ?out/i.test(text)) e.status = 503;
  return e;
}

/** Read one account: each stream the owner allows, from its last point. */
export async function syncWork(connectorId: string, opts: WorkSyncOptions): Promise<WorkSyncResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const none = (state: WorkSyncResult["state"], extra: Partial<WorkSyncResult> = {}): WorkSyncResult => ({ state, issues: 0, prs: 0, updated: 0, read: 0, ...extra });
  const connector = await getConnector(connectorId).catch(() => null);
  if (!connector || !isWork(connector.provider) || !allowsWork(connector)) return none("off");
  // Switched off: no collection reads it, so nothing is opened or called.
  if (!workSyncOn(connectorId, await listCollections())) return none("off");
  const stored = await getWorkSync(connectorId);
  if (stored?.resume_at && stored.resume_at > iso()) return none("waiting", { message: stored.error, resume_at: stored.resume_at });
  if (!(await claim(connectorId, iso(started + opts.budgetMs + 120_000), iso()))) return none("busy");

  const tz = await getOwnerTimeZone();
  const today = zonedToday(new Date(clock()), tz);
  const yesterday = zonedToInstant(addDays(today, -1), "00:00", tz).getTime();
  const streams: Record<string, StreamState> = structuredClone(stored?.streams ?? {});
  const out = none("checked");
  const allowed = new Set(connector.allowed_tools);
  let open: OpenConnector | null = null;
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (!allowed.has(tool)) throw new Error(`${tool} isn't allowed`);
    const r = await (opts.call ?? ((o, t, a) => callTool(o, t, a, { full: true })))(open!, tool, args);
    if (r.isError) throw toolError(r.text);
    return r.text;
  };
  const save = (items: WorkItem[]) => saveWorkItems(items);
  const over = () => clock() - started > opts.budgetMs;

  try {
    open = await (opts.open ?? opener)(connectorId);
    if (connector.provider === "linear") {
      const me = linearMe(await call("get_user", { query: "me" }));
      const st = (streams.issues ??= {});
      // A read left part-way first (older changes), then the recent ones.
      const runs = readPlan(st, started, yesterday);
      delete st.pending;
      for (const r of runs) {
        let cursor = r.at;
        for (let n = 0; n < MAX_PAGES; n++) {
          const page = linearIssues(await call("list_issues", { assignee: "me", updatedAt: r.since, orderBy: "updatedAt", limit: PAGE_SIZE, includeArchived: true, ...(cursor ? { cursor } : {}) }), me);
          out.read += page.read;
          const w = await save(page.issues);
          out.issues += w.created;
          out.updated += w.updated;
          if (page.newest && (!st.last || page.newest > st.last)) st.last = page.newest;
          cursor = page.next;
          if (!cursor) break;
          if (over() || n === MAX_PAGES - 1) {
            st.pending = { since: r.since, at: cursor };
            break;
          }
        }
        // Stopped part-way: carried on next run, before anything newer (which the next run's recent read covers).
        if (st.pending || over()) break;
      }
    } else {
      const me = githubMe(await call("get_me", {}));
      const known = new Map((await readWorkItems({ source: "github" })).items.map((i) => [i.id, i as WorkPr]));
      let reviewReads = 0;
      const canReview = allowed.has("pull_request_read");
      for (const role of ["opened", "reviewed", "merged"] as const) {
        // Who merged it is only in pull_request_read: without it, merges for others aren't read at all.
        if (role === "merged" && !canReview) continue;
        const st = (streams[role] ??= {});
        const runs = readPlan(st, started, yesterday).map((r) => ({ ...r, page: Number(r.at) || 1 }));
        delete st.pending;
        for (const r of runs) {
          const day = r.since.slice(0, 10);
          const query =
            role === "opened" ? `is:pr author:${me.login} updated:>=${day}` : role === "reviewed" ? `is:pr reviewed-by:${me.login} -author:${me.login} updated:>=${day}` : `is:pr is:merged involves:${me.login} -author:${me.login} updated:>=${day}`;
          for (let p = r.page; p < r.page + MAX_PAGES; p++) {
            const page = githubPrs(await call("search_pull_requests", { query, sort: "updated", order: "desc", perPage: PAGE_SIZE, page: p }), me, role);
            out.read += page.read;
            const items: WorkPr[] = [];
            for (const pr of page.prs) {
              const before = known.get(pr.id);
              if (role === "merged") {
                // Kept only once the PR itself says the owner merged it; checked again only when it changed.
                if (before && before.updated === pr.updated) {
                  items.push(before);
                  continue;
                }
                const k = workKey("github", pr.id);
                if (pr.updated && st.not_mine?.[k] === pr.updated) continue;
                if (reviewReads >= MAX_REVIEW_READS || over()) continue;
                reviewReads++;
                const [owner, repo] = pr.repo.split("/");
                const m = githubMergedBy(await call("pull_request_read", { method: "get", owner, repo, pullNumber: pr.number }), me);
                if (!m.mine) {
                  if (pr.updated) (st.not_mine ??= {})[k] = pr.updated;
                  continue;
                }
                const item: WorkPr = { ...pr, merged: m.at };
                items.push(item);
                known.set(item.id, item);
                if (pr.updated && (!st.last || pr.updated > st.last)) st.last = pr.updated;
                continue;
              }
              const fresh = !before || before.updated !== pr.updated || (role === "opened" ? before.reviews === undefined : before.reviewed_at === undefined);
              let item: WorkPr = { ...pr, ...(before?.reviews !== undefined ? { reviews: before.reviews } : {}), ...(before?.reviewed_at ? { reviewed_at: before.reviewed_at } : {}) };
              if (fresh && canReview && reviewReads < MAX_REVIEW_READS && !over()) {
                reviewReads++;
                const [owner, repo] = pr.repo.split("/");
                const rv = githubReviews(await call("pull_request_read", { method: "get_reviews", owner, repo, pullNumber: pr.number, perPage: 100 }), me);
                item = role === "opened" ? { ...item, reviews: rv.others } : { ...item, ...(rv.mine_first ? { reviewed_at: rv.mine_first } : {}) };
              }
              items.push(item);
              known.set(item.id, item);
              if (pr.updated && (!st.last || pr.updated > st.last)) st.last = pr.updated;
            }
            const w = await save(items);
            out.prs += w.created;
            out.updated += w.updated;
            const more = page.read >= PAGE_SIZE && (page.total === undefined || p * PAGE_SIZE < page.total);
            if (!more) break;
            if (over() || p === r.page + MAX_PAGES - 1) {
              st.pending = { since: r.since, at: String(p + 1) };
              break;
            }
          }
          if (st.pending || over()) break;
        }
      }
    }
    // Keep a week of "not mine" checks: older ones fall out of every read window anyway.
    for (const st of Object.values(streams)) if (st.not_mine) st.not_mine = Object.fromEntries(Object.entries(st.not_mine).filter(([, u]) => Date.parse(u) > clock() - 8 * 86_400_000));
    await patchState(connectorId, { streams, last_at: iso(), lease_until: undefined, resume_at: undefined, error: undefined });
    console.log(`Athena work sync (${connector.provider}): ${out.read} read, ${out.issues} issues and ${out.prs} pull requests new, ${out.updated} changed`);
    return out;
  } catch (error) {
    if (error instanceof ShapeUnknown) {
      // Nothing from this reply was stored; the account is failed with a plain error until a run reads it cleanly.
      await patchState(connectorId, { streams, lease_until: undefined, error: error.message });
      console.error(`Athena work sync (${connector.provider}): a reply in a shape Athena doesn't know${error.detail ? `: ${error.detail}` : ""}`);
      return { ...out, state: "failed", message: error.message };
    }
    const w = error instanceof ConnectorNeedsSignIn ? { ms: 0, status: 401, message: `${connector.name} needs signing in again`, owner: true } : waitAfter(error, connector.name);
    if (w.owner) {
      await patchState(connectorId, { streams, lease_until: undefined });
      console.error(`Athena work sync (${connector.provider}): needs the owner`);
      return { ...out, state: "blocked", message: w.message };
    }
    const resume = iso(clock() + w.ms);
    await patchState(connectorId, { streams, lease_until: undefined, resume_at: resume, error: w.message });
    console.error(`Athena work sync (${connector.provider}): stopped${w.status ? ` (${w.status})` : ""}, trying again later`);
    return { ...out, state: "waiting", message: w.message, resume_at: resume };
  } finally {
    await open?.close().catch(() => undefined);
  }
}

// ---------- A run (runner.ts) ----------

export interface WorkSyncRun {
  status: "succeeded" | "failed";
  summary: string;
  error?: string;
  stats: RunStatsJson;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const clockTime = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });

/** "3 issues, 2 pull requests", or "Nothing new". */
export function workSyncLine(n: { issues: number; prs: number }): string {
  const parts = [n.issues ? plural(n.issues, "issue", "issues") : "", n.prs ? plural(n.prs, "pull request", "pull requests") : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing new";
}

/** One run: each chosen work account, read without a model. Counts only in the summary. */
export async function runWorkSync(collection: Pick<Collection, "connector_ids">, opts: Omit<WorkSyncOptions, "budgetMs"> = {}): Promise<WorkSyncRun> {
  const tz = await getOwnerTimeZone();
  const total = { issues: 0, prs: 0, updated: 0 };
  const blocked: string[] = [];
  const notes: string[] = [];
  let checked = 0;
  let accounts = 0;
  let failed = 0;
  for (const id of collection.connector_ids) {
    const c = await getConnector(id).catch(() => null);
    if (!c || !countsWork(c)) continue;
    accounts++;
    if (c.status === "needs_auth" || c.status === "pending") {
      blocked.push(id);
      continue;
    }
    if (!allowsWork(c)) {
      notes.push(`${c.name}: allow ${WORK_TOOLS[c.provider as Provider].needs.join(" and ")} under What Athena can read`);
      continue;
    }
    const r = await syncWork(id, { ...opts, budgetMs: PER_ACCOUNT_MS }).catch((error): WorkSyncResult => {
      console.error("Athena work sync: a check failed", error instanceof Error ? error.message : "unknown error");
      return { state: "waiting", issues: 0, prs: 0, updated: 0, read: 0, message: `Couldn't reach ${c.name}` };
    });
    total.issues += r.issues;
    total.prs += r.prs;
    total.updated += r.updated;
    if (r.state === "checked") checked++;
    if (r.state === "blocked") blocked.push(id);
    if (r.state === "failed") {
      failed++;
      notes.push(r.message ?? `${c.name} couldn't be read`);
    }
    if (r.state === "waiting" && r.message) notes.push(r.resume_at ? `${r.message} · trying again at ${clockTime(r.resume_at, tz)}` : r.message);
  }
  const stats: RunStatsJson = { issues_new: total.issues, prs_new: total.prs, work_updated: total.updated, accounts_checked: checked, waiting: notes.length, ...(blocked.length ? { blocked_by: blocked } : {}) };
  const summary = [workSyncLine(total), ...notes].join(". ");
  if (!accounts) return { status: "failed", summary: "", error: "None of the accounts is Linear or GitHub. Add one of them.", stats };
  if (!checked && failed) return { status: "failed", summary, error: notes.join(". "), stats };
  if (!checked && blocked.length === accounts) return { status: "failed", summary, error: "Every account needs signing in again.", stats };
  return { status: "succeeded", summary, stats };
}
