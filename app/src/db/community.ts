/**
 * Community, for the app: the calls the `#/community` and `#/add` screens make, and their routes. The shapes are
 * lib/community-api.ts; the server's side is planned as netlify/lib/community-routes.ts. The calls are not built
 * yet: each throws until its session builds it. The routes are pure and tested.
 *
 * Every way in ends at `#/add`, one preview screen:
 *   #/add?catalogue=<id>   a listing from the Community screen
 *   #/add?link=<url>       a github.com link someone sent
 *   #/add                  files: picked, dropped, or from the installed app's share target (held in memory)
 * `#/community` is the catalogue itself.
 */
import type { IntakeEntry } from "../../../lib/skills";
import type { AddChoices, AddPreview, AddResult, CatalogueView, UpdateCheck } from "../../../lib/community-api";
import { isSampleMode, request } from "./api";

export type { AddChoices, AddPreview, AddResult, CatalogueView, UpdateCheck };

/** Where an item to add comes from. */
export type AddSource = { catalogue: string } | { link: string } | { files: IntakeEntry[] };

export const COMMUNITY_ROUTE = "#/community";
export const ADD_ROUTE = "#/add";

/** The `#/add` address for a listing or a link. Files have none: the screen takes them in memory. Pure. */
export function addHash(source: { catalogue: string } | { link: string }): string {
  return "catalogue" in source ? `${ADD_ROUTE}?catalogue=${encodeURIComponent(source.catalogue)}` : `${ADD_ROUTE}?link=${encodeURIComponent(source.link)}`;
}

/**
 * What a `#/add` address asks for: a listing, a link, or files (`{ files: [] }`, for the screen to fill from what
 * it holds). Null for any other address. A listing wins when both are given. Pure.
 */
export function parseAddHash(hash: string): AddSource | null {
  const [path, qs] = hash.replace(/^#\/?/, "").split("?");
  if (path.replace(/\/+$/, "") !== "add") return null;
  const params = new URLSearchParams(qs ?? "");
  const catalogue = params.get("catalogue")?.trim();
  if (catalogue) return { catalogue };
  const link = params.get("link")?.trim();
  if (link) return { link };
  return { files: [] };
}

const notBuilt = (what: string): never => {
  throw new Error(`${what}: not built yet`);
};

// ---------- the catalogue and update checks (the Community screen's session) ----------

/** Sample mode's switch: "on" or "off"; missing until Community is first opened. */
export const SAMPLE_COMMUNITY_SWITCH = "athena.sample.community";
/**
 * Sample mode only, to see each state of the screen: "none" (not set up), "down" (unreachable), "offline" or
 * "slow" (a long load). Missing: the sample catalogue answers.
 */
export const SAMPLE_CATALOGUE_STATE = "athena.sample.catalogue";

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage blocked: kept for this visit only
    }
  },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sampleView(): Promise<CatalogueView> {
  const state = store.get(SAMPLE_CATALOGUE_STATE);
  if (state === "offline") throw new TypeError("Failed to fetch");
  if (state === "slow") await wait(8000);
  const configured = state !== "none";
  // Opening Community the first time switches the check on, as on a real Athena.
  if (configured && store.get(SAMPLE_COMMUNITY_SWITCH) === null) store.set(SAMPLE_COMMUNITY_SWITCH, "on");
  const on = store.get(SAMPLE_COMMUNITY_SWITCH) === "on";
  const view: CatalogueView = { configured, on, host: configured ? "catalogue.example.com" : null, generated_at: null, items: [], added: [], error: null };
  if (!configured || !on) return view;
  if (state === "down") return { ...view, error: "Athena couldn't reach the Community catalogue." };
  const { sampleCatalogue, SAMPLE_ADDED } = await import("./sample-community");
  const index = await sampleCatalogue();
  const items = [...index.items].sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
  return { ...view, generated_at: index.generated_at, items, added: [...SAMPLE_ADDED] };
}

/** GET /api/community: the catalogue as the server last read it, and the owner's switch. */
export async function fetchCatalogue(): Promise<CatalogueView> {
  if (isSampleMode()) return sampleView();
  const view = await request<CatalogueView>("/community");
  updatesCache = null;
  return view;
}

/** PUT /api/community/settings: the owner's "Check the Community catalogue" switch. */
export async function setCommunityCheck(on: boolean): Promise<boolean> {
  updatesCache = null;
  if (isSampleMode()) {
    store.set(SAMPLE_COMMUNITY_SWITCH, on ? "on" : "off");
    return on;
  }
  return (await request<{ on: boolean }>("/community/settings", { method: "PUT", body: JSON.stringify({ on }) })).on;
}

/** GET /api/community/settings: the switch, and whether a catalogue is set at all. */
export async function loadCommunityCheck(): Promise<{ on: boolean; configured: boolean }> {
  if (isSampleMode()) return { on: store.get(SAMPLE_COMMUNITY_SWITCH) !== "off", configured: store.get(SAMPLE_CATALOGUE_STATE) !== "none" };
  return request<{ on: boolean; configured: boolean }>("/community/settings");
}

/** POST /api/community/preview: the item read and checked, its reach worked out. Nothing is kept. */
export async function previewAdd(source: AddSource): Promise<AddPreview> {
  void source;
  return notBuilt("previewAdd");
}

/** POST /api/community/add: keeps it, switched off, with only what the owner chose. */
export async function addItem(preview: AddPreview, choices: AddChoices): Promise<AddResult> {
  void preview;
  void choices;
  return notBuilt("addItem");
}

/** One answer from the updates check, shared by the item pages for a few minutes. */
let updatesCache: { at: number; checks: Promise<UpdateCheck[]> } | null = null;
const UPDATES_FRESH_MS = 5 * 60 * 1000;

/** GET /api/community/updates: items added from the catalogue that have a newer version or were taken down. */
export async function checkUpdates(): Promise<UpdateCheck[]> {
  if (updatesCache && Date.now() - updatesCache.at < UPDATES_FRESH_MS) return updatesCache.checks;
  const checks = isSampleMode()
    ? store.get(SAMPLE_COMMUNITY_SWITCH) === "off"
      ? Promise.resolve([])
      : import("./sample-community").then((m) => m.sampleUpdates())
    : request<{ updates: UpdateCheck[] }>("/community/updates").then((r) => r.updates);
  updatesCache = { at: Date.now(), checks };
  checks.catch(() => (updatesCache = null));
  return checks;
}

/** What the updates check says about one assistant, skill or flow here, or null. Never throws. */
export async function updateFor(kind: UpdateCheck["kind"], id: string): Promise<UpdateCheck | null> {
  try {
    return (await checkUpdates()).find((c) => c.kind === kind && c.id === id) ?? null;
  } catch {
    return null;
  }
}

/** Forget the last updates check: after the owner removes, switches on or updates an item. */
export function forgetUpdates(): void {
  updatesCache = null;
}
