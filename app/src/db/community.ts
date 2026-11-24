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

/** GET /api/community: the catalogue as the server last read it, and the owner's switch. */
export async function fetchCatalogue(): Promise<CatalogueView> {
  return notBuilt("fetchCatalogue");
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

/** GET /api/community/updates: items added from the catalogue that have a newer version or were taken down. */
export async function checkUpdates(): Promise<UpdateCheck[]> {
  return notBuilt("checkUpdates");
}
