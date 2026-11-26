/**
 * Community's routes (lib/community-api.ts), behind the same bearer token as the rest of the API:
 *
 *   GET /api/community            → CatalogueView. The first time it's opened, the check is switched on; once
 *                                   the owner has set the switch, it's theirs.
 *   POST /api/community/check     → CatalogueView with `checked`: "Check for new items". The index is read again only
 *                                   when the copy kept is over ten minutes old (community-catalogue.ts checkIndex).
 *   GET /api/community/updates    → { updates: UpdateCheck[] }: what was added from the catalogue that has a newer
 *                                   listing or was taken down. Pauses a withdrawn item once.
 *   PUT /api/community/settings   { on: boolean } → { on: boolean }
 *
 * Nothing here contacts the catalogue while ATHENA_CATALOGUE_URL is empty or the switch is off, and the updates
 * check fetches nothing while nothing from the catalogue is added. The index is read at most once a day unless
 * the owner asks for a fresh list, or the copy kept was made by an Athena that knew fewer kinds
 * (netlify/lib/community-catalogue.ts); the daily check (netlify/functions/community-check.ts) uses the same code.
 */
import { AthenaInputError, q } from "../../lib/db";
import { COMMUNITY_KEY, readCommunityCheck, saveCommunityCheck, submitPageUrl } from "../../lib/community-config";
import { CatalogueError } from "../../lib/catalogue-types";
import type { CatalogueView, CommunitySettings, UpdateCheck } from "../../lib/community-api";
import type { Reach } from "../../lib/reach";
import type { CatalogueItem } from "../../lib/catalogue-types";
import { catalogueDeps, checkIndex, compareInstalled, flowTier, getIndex, pauseKey, readableItems, themeSwatchesFor, toPause, type InstalledItem } from "./community-catalogue";

type Json = (data: unknown, status?: number) => Response;

/** Where the routes keep and read things. Replaceable in tests. */
export interface CommunityStore {
  /** The switch's row as stored, or undefined when the owner has never set it. */
  switchRow(): Promise<unknown | undefined>;
  saveSwitch(on: boolean): Promise<{ on: boolean }>;
  installed(): Promise<InstalledItem[]>;
  pausedBefore(): Promise<Set<string>>;
  rememberPaused(keys: string[]): Promise<void>;
  pause(rows: InstalledItem[]): Promise<void>;
  tierHere(row: InstalledItem): Promise<Reach["tier"] | null>;
  /** A few colours of each listed theme, for its row (netlify/lib/community-catalogue.ts themeSwatchesFor). */
  swatches?(items: CatalogueItem[]): Promise<CatalogueView["swatches"]>;
}

const PAUSED_KEY = "community_paused";
/** Items remembered as paused for a withdrawal: the newest this many. */
const PAUSED_KEPT = 500;

export const dbCommunityStore: CommunityStore = {
  async switchRow() {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [COMMUNITY_KEY]);
    return row ? row.value : undefined;
  },
  saveSwitch: (on) => saveCommunityCheck({ on }),
  async installed() {
    // Themes ride in the `theme` settings row with the owner's own (lib/theme-prefs.ts), not in a table of their own.
    const themes = await (await import("../../lib/theme-prefs")).themesFromCommunity();
    const rows = await q<InstalledItem>(
      `SELECT 'assistant' AS kind, id::text AS id, catalogue_id, catalogue_hash, catalogue_version, NOT paused AS "on" FROM team_assistants WHERE catalogue_id IS NOT NULL AND catalogue_hash IS NOT NULL
       UNION ALL
       SELECT 'skill', id::text, catalogue_id, catalogue_hash, catalogue_version, enabled FROM ask_skills WHERE catalogue_id IS NOT NULL AND catalogue_hash IS NOT NULL AND assistant_id IS NULL
       UNION ALL
       SELECT 'flow', id::text, catalogue_id, catalogue_hash, catalogue_version, NOT paused FROM flows WHERE catalogue_id IS NOT NULL AND catalogue_hash IS NOT NULL
       UNION ALL
       SELECT 'checkin', id::text, catalogue_id, catalogue_hash, catalogue_version, NOT paused FROM checkin_sets WHERE catalogue_id IS NOT NULL AND catalogue_hash IS NOT NULL
       UNION ALL
       SELECT 'template', id::text, catalogue_id, catalogue_hash, catalogue_version, false FROM note_templates WHERE catalogue_id IS NOT NULL AND catalogue_hash IS NOT NULL AND archived_at IS NULL AND origin = 'shared'`
    );
    return [...rows, ...themes];
  },
  async pausedBefore() {
    const [row] = await q<{ value: { keys?: unknown } }>(`SELECT value FROM settings WHERE key = $1`, [PAUSED_KEY]);
    const keys = row?.value?.keys;
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  },
  async rememberPaused(keys) {
    if (!keys.length) return;
    const all = [...(await this.pausedBefore()), ...keys].slice(-PAUSED_KEPT);
    await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [PAUSED_KEY, JSON.stringify({ keys: [...new Set(all)] })]);
  },
  async pause(rows) {
    const ids = (kind: InstalledItem["kind"]) => rows.filter((r) => r.kind === kind).map((r) => r.id);
    if (ids("assistant").length) await q(`UPDATE team_assistants SET paused = true, updated_at = now() WHERE id = ANY($1::uuid[])`, [ids("assistant")]);
    if (ids("skill").length) await q(`UPDATE ask_skills SET enabled = false, updated_at = now() WHERE id = ANY($1::uuid[])`, [ids("skill")]);
    if (ids("flow").length) await q(`UPDATE flows SET paused = true, updated_at = now() WHERE id = ANY($1::uuid[])`, [ids("flow")]);
    // A set switched off: its questions aren't asked until the owner switches it back on (lib/checkin-sets.ts).
    if (ids("checkin").length) await q(`UPDATE checkin_sets SET paused = true, updated_at = now() WHERE id = ANY($1::uuid[])`, [ids("checkin")]);
    // A template never runs, so there's nothing to switch off: installed() reports it as not running, and a taken-down
    // template only shows the catalogue's reason beside it. It stays the owner's, usable, until they remove it. The
    // same goes for a theme: it stays in use if it is, with the reason in its editor.
  },
  swatches: (items) => themeSwatchesFor(items),
  async tierHere(row) {
    if (row.kind === "skill") return 2;
    if (row.kind === "checkin") return (await import("../../lib/checkin-sets")).checkinSetTier(row.id);
    if (row.kind === "template") return (await import("../../lib/templates-db")).templateTier(row.id);
    if (row.kind === "theme") return (await import("../../lib/theme-prefs")).themeTier(row.id);
    if (row.kind === "assistant") {
      const [a] = await q<{ web: boolean }>(`SELECT web FROM team_assistants WHERE id = $1::uuid`, [row.id]);
      return a ? (a.web ? 3 : 2) : null;
    }
    const { getFlow } = await import("../../lib/flows");
    const f = await getFlow(row.id);
    return f ? flowTier(f.steps) : null;
  },
};

/**
 * The Community screen's data. Opening it the first time switches the check on. With `check`, the owner asked for a
 * fresh list: the index is read again only if the copy kept is over ten minutes old, and `checked` says which.
 */
export async function catalogueView(store: CommunityStore = dbCommunityStore, opts: { check?: boolean } = {}): Promise<CatalogueView> {
  const configured = !!catalogueDeps.root();
  const raw = await store.switchRow();
  let on = readCommunityCheck(raw);
  if (configured && raw === undefined && !opts.check) on = (await store.saveSwitch(true)).on;
  const root = catalogueDeps.root();
  const view: CatalogueView = { configured, on, host: root ? root.replace(/^https?:\/\//, "") : null, generated_at: null, fetched_at: null, items: [], added: [], error: null };
  if (!configured || !on) return view;
  const added = [...new Set((await store.installed()).map((r) => r.catalogue_id))];
  try {
    const read = opts.check ? await checkIndex() : await getIndex();
    const items = readableItems(read.index);
    const swatches = items.some((i) => i.kind === "theme") ? ((await store.swatches?.(items).catch(() => undefined)) ?? undefined) : undefined;
    return { ...view, generated_at: read.index.generated_at, fetched_at: read.fetched_at, items, added, error: read.error, ...(opts.check ? { checked: read.cached && !read.error ? "recent" : "read" } : {}), ...(swatches ? { swatches } : {}) };
  } catch (e) {
    return { ...view, added, error: e instanceof Error ? e.message : "Athena couldn't reach the Community catalogue.", ...(opts.check ? { checked: "read" as const } : {}) };
  }
}

/**
 * What was added from the catalogue, against the index: newer listings and withdrawals. A withdrawn item that's
 * running is paused, once. Fetches nothing unless Community is set up, the switch is on and something was added.
 */
export async function communityUpdates(store: CommunityStore = dbCommunityStore): Promise<UpdateCheck[]> {
  if (!catalogueDeps.root() || !readCommunityCheck(await store.switchRow())) return [];
  const rows = await store.installed();
  if (!rows.length) return [];
  let index;
  try {
    index = (await getIndex()).index;
  } catch {
    return [];
  }
  const pause = toPause(rows, index, await store.pausedBefore());
  if (pause.length) {
    await store.pause(pause);
    await store.rememberPaused(pause.map(pauseKey));
  }
  const checks = compareInstalled(rows, index);
  for (const c of checks) {
    if (!c.newer) continue;
    const row = rows.find((r) => r.kind === c.kind && r.id === c.id)!;
    c.tier_here = await store.tierHere(row).catch(() => null);
  }
  return checks;
}

export async function handleCommunityRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json, store: CommunityStore = dbCommunityStore): Promise<Response | null> {
  // ["api", "community", <check | updates | settings>?]
  const [, , second] = segments;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);
  try {
    if (!second && segments.length === 2) return method === "GET" ? json(await catalogueView(store)) : nope();
    if (second === "check" && segments.length === 3) return method === "POST" ? json(await catalogueView(store, { check: true })) : nope();
    if (second === "updates" && segments.length === 3) return method === "GET" ? json({ updates: await communityUpdates(store) }) : nope();
    if (second === "settings" && segments.length === 3) {
      if (method === "GET") {
        const root = catalogueDeps.root();
        const settings: CommunitySettings = { on: readCommunityCheck(await store.switchRow()), configured: !!root, submit: submitPageUrl(root) };
        return json(settings);
      }
      if (method !== "PUT") return nope();
      const on = ((await body()) as { on?: unknown } | null)?.on;
      if (typeof on !== "boolean") throw new AthenaInputError("Send on: true or false");
      return json(await store.saveSwitch(on));
    }
    return null;
  } catch (e) {
    if (e instanceof AthenaInputError) return json({ error: e.message }, e.status);
    if (e instanceof CatalogueError) return json({ error: e.message }, e.status);
    throw e;
  }
}
