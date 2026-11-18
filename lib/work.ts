/**
 * The owner's own work, counted (migration 0066): Linear issues assigned to
 * them and GitHub pull requests they opened or reviewed, as the work sync
 * read them (netlify/lib/connectors/work-sync.ts), with no model in between.
 *
 * One row per item in work_items, keyed by its source and a hash of its id,
 * so a re-read replaces it and never adds a second copy. Everything about
 * the item (title, project, team, repo, times) is one sealed JSON value: the
 * table holds a source, a hash, a kind and ciphertext. Nothing about anyone
 * else is ever stored: work-parse.ts drops a teammate's issue or a PR's
 * author before it gets here, and saveWorkItems refuses an issue or PR that
 * isn't marked as the owner's.
 *
 * The page (GET /api/life/work, lib/work-stats.ts) and Ask's `work` tool
 * read it back through readWorkItems.
 */
import { createHash } from "node:crypto";
import { currentKeyId, dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { qRaw } from "./db";

export type WorkSource = "linear" | "github";

/** A Linear issue assigned to the owner. Times are ISO, UTC. */
export interface WorkIssue {
  source: "linear";
  id: string;
  identifier?: string;
  title: string;
  url?: string;
  project?: string;
  project_id?: string;
  team?: string;
  state?: string;
  /** Linear's state type when given (started, completed, canceled…). */
  state_type?: string;
  created?: string;
  started?: string;
  completed?: string;
  canceled?: string;
  updated?: string;
  estimate?: number;
}

/** A GitHub pull request the owner opened, or someone else's they reviewed or merged (its author isn't kept). */
export interface WorkPr {
  source: "github";
  /** "owner/repo#12". */
  id: string;
  repo: string;
  number: number;
  title: string;
  url?: string;
  role: "opened" | "reviewed" | "merged";
  opened?: string;
  merged?: string;
  closed?: string;
  updated?: string;
  draft?: boolean;
  /** Opened: reviews other people left, as a count. */
  reviews?: number;
  /** Reviewed: when the owner first reviewed it. */
  reviewed_at?: string;
}

export type WorkItem = WorkIssue | WorkPr;

const kindOf = (i: WorkItem) => (i.source === "linear" ? "issue" : "pr");

/** The row's key: a hash of the source and the item's id, so no id or repo name sits readable in the table. */
export const workKey = (source: WorkSource, id: string) => createHash("sha256").update(`${source}\u0000${id}`).digest("base64url").slice(0, 22);

/** An item that is the owner's own, or null: the last check before storage. */
export function ownItem(i: WorkItem): WorkItem | null {
  if (i.source === "linear") return i.id && i.title ? i : null;
  if (i.source === "github") return i.id && i.title && (i.role === "opened" || i.role === "reviewed" || i.role === "merged") && !("author" in i) && !("user" in i) ? i : null;
  return null;
}

/** Keys the stored value never carries, whatever a caller passes: people. */
const NEVER = new Set(["author", "user", "assignee", "assigneeId", "assignees", "reviewers", "requested_reviewers", "creator", "createdBy", "createdById", "description", "body"]);
const stripped = (i: WorkItem): WorkItem => Object.fromEntries(Object.entries(i).filter(([k, v]) => !NEVER.has(k) && v !== undefined)) as unknown as WorkItem;

/** Save items: new ones added, changed ones replaced, the same left alone. Needs the data key. */
export async function saveWorkItems(items: WorkItem[]): Promise<{ created: number; updated: number; unchanged: number }> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const n = { created: 0, updated: 0, unchanged: 0 };
  const kept = items.map(ownItem).filter((i): i is WorkItem => !!i).map(stripped);
  if (!kept.length) return n;
  const keys = kept.map((i) => workKey(i.source, i.id));
  const rows = await qRaw<{ source: string; item_key: string; sealed: string }>(`SELECT source, item_key, sealed FROM work_items WHERE item_key = ANY($1::text[])`, [keys]);
  const prev = new Map(rows.map((r) => [`${r.source} ${r.item_key}`, r.sealed]));
  const kid = currentKeyId();
  for (let j = 0; j < kept.length; j++) {
    const i = kept[j];
    const value = JSON.stringify(i);
    const old = prev.get(`${i.source} ${keys[j]}`);
    if (old) {
      try {
        if (openStrict(old) === value && old.startsWith(`enc:v1:${kid}:`)) {
          n.unchanged++;
          continue;
        }
      } catch {
        // Unreadable under the current key: replaced.
      }
    }
    await qRaw(
      `INSERT INTO work_items (source, item_key, kind, sealed) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source, item_key) DO UPDATE SET sealed = EXCLUDED.sealed, kind = EXCLUDED.kind, updated_at = now()`,
      [i.source, keys[j], kindOf(i), sealText(value)],
    );
    if (old) n.updated++;
    else n.created++;
  }
  return n;
}

/** Every stored item, opened. Ones that won't open (a key gone) are counted, not returned. */
export async function readWorkItems(opts: { source?: WorkSource } = {}): Promise<{ items: WorkItem[]; unreadable: number }> {
  const rows = await qRaw<{ sealed: string }>(`SELECT sealed FROM work_items ${opts.source ? "WHERE source = $1" : ""} ORDER BY created_at`, opts.source ? [opts.source] : []);
  const items: WorkItem[] = [];
  let unreadable = 0;
  for (const r of rows) {
    try {
      items.push(JSON.parse(openStrict(r.sealed)) as WorkItem);
    } catch {
      unreadable++;
    }
  }
  return { items, unreadable };
}

/** Which sources have anything stored. */
export async function workSources(): Promise<WorkSource[]> {
  const rows = await qRaw<{ source: WorkSource }>(`SELECT DISTINCT source FROM work_items`);
  return rows.map((r) => r.source);
}
