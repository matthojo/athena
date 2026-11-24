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
import { ApiError, getToken, isSampleMode, request } from "./api";
import { answersFor, buildPreview, itemFiles, NEWER_FORMAT_STATUS, sourceFor } from "../../../lib/community-add";
import { verifyBundle } from "../../../lib/catalogue-types";
import { importSharedFlow } from "../../../lib/flow-share";
import { ShareFormatError } from "../../../lib/team-share";
import { splitWouldLike } from "../../../lib/shared-limits";
import { MAX_ASSISTANTS } from "../../../lib/team-types";
import { sampleBundle } from "./sample-community";
import { sampleLinkFiles } from "../add/sample-items";
import { addImported } from "./team-share";
import { listTeam, teamChanged } from "./team";
import { fetchSkills, saveSkill } from "./skills";
import { createFlow, flowsChanged } from "./flows";

export type { AddChoices, AddPreview, AddResult, CatalogueView, UpdateCheck };

/** Where an item to add comes from. */
export type AddSource = { catalogue: string } | { link: string } | { files: IntakeEntry[]; name?: string };

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
  if (isSampleMode()) return samplePreview(source);
  if ("files" in source) {
    // Files go as multipart, one part each with its path beside it: a folder's paths survive any browser.
    const form = new FormData();
    for (const e of source.files) {
      form.append("files", new Blob([e.bytes as BlobPart]), e.path.split("/").pop() || "file");
      form.append("path", e.path);
    }
    if (source.name) form.append("name", source.name);
    const token = getToken();
    const res = await fetch("/api/community/preview", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
    const body = (await res.json().catch(() => ({}))) as { preview?: AddPreview; error?: string };
    if (!res.ok || !body.preview) throw new ApiError(body.error ?? "That didn't work. Check you're online.", res.status);
    return body.preview;
  }
  return (await request<{ preview: AddPreview }>("/community/preview", { method: "POST", body: JSON.stringify(source) })).preview;
}

/** POST /api/community/add: keeps it, switched off, with only what the owner chose. */
export async function addItem(preview: AddPreview, choices: AddChoices): Promise<AddResult> {
  const result = isSampleMode() ? await sampleAdd(preview, choices) : await request<AddResult>("/community/add", { method: "POST", body: JSON.stringify({ preview, choices }) });
  // The lists that hold it follow.
  if (result.kind === "assistant") teamChanged();
  else if (result.kind === "flow") flowsChanged();
  return result;
}

/** Did it fail because the file was made for a newer Athena? (426 from the server, NewerFormatError in sample mode.) */
export const isNewerFormat = (error: unknown): boolean => (error as { status?: number } | null)?.status === NEWER_FORMAT_STATUS || (error as { newer?: boolean } | null)?.newer === true;

// ---------- sample mode: the same reading as the server's, with made-up items ----------

const utf8 = new TextEncoder();

async function samplePreview(source: AddSource): Promise<AddPreview> {
  const at = new Date().toISOString();
  try {
    if ("catalogue" in source) {
      const { item, bundle } = await sampleBundle(source.catalogue);
      if (!(await verifyBundle(bundle, item))) throw new ShareFormatError("That listing's files don't match what the catalogue says they are, so Athena won't use them.");
      const kind = item.kind;
      return await buildPreview({ files: { kind, files: bundle.files, skipped: [], folder: null }, from: { catalogue: item.id }, source: sourceFor({ catalogue: item.id }, at, "https://catalogue.example.com"), listing: item, existing: null });
    }
    if ("link" in source) {
      await new Promise((r) => setTimeout(r, 500));
      const files = sampleLinkFiles(source.link);
      if (!files) throw new ShareFormatError("Sample mode can only read its made-up items. Tap Try something else to see them.");
      return await buildPreview({ files: itemFiles(files.map((f) => ({ path: f.path, bytes: utf8.encode(f.text) }))), from: { link: source.link }, source: sourceFor({ link: source.link }, at) });
    }
    if (source.files.length === 1 && /\.zip$/i.test(source.files[0].path)) throw new ShareFormatError("In sample mode Athena can read a file or a folder, but not a zip.");
    const files = itemFiles(source.files);
    const name = source.name || files.folder || source.files[0]?.path.split("/")[0] || "";
    return await buildPreview({ files, from: { files: name }, source: sourceFor({ files: name }, at) });
  } catch (error) {
    if (error instanceof Error && error.message === "not built yet") throw new Error("Sample mode's catalogue isn't here yet.");
    throw error;
  }
}

async function sampleAdd(p: AddPreview, choices: AddChoices): Promise<AddResult> {
  const item = p.item;
  if (item.kind === "assistant") {
    const { offered, asksFirst } = splitWouldLike(item.shared.would_like);
    const team = await listTeam();
    const made = await addImported(
      { shared: { ...item.shared, would_like: offered }, skill: item.skill, source: sourceFor(p.from, new Date().toISOString()), asks_first: asksFirst, needs: [], accounts: [], links: [], room: team.length < MAX_ASSISTANTS },
      { answers: answersFor(item.shared.asks, choices.answers), allow: choices.allow, web: choices.web, accounts: choices.accounts },
    );
    return { kind: "assistant", id: made.id, href: `#/team/${encodeURIComponent(made.id)}` };
  }
  if (item.kind === "skill") {
    const s = item.skill;
    const taken = new Set((await fetchSkills()).map((x) => x.name));
    let name = s.name;
    for (let n = 2; taken.has(name); n++) name = `${s.name.slice(0, 60)}-${n}`;
    const saved = await saveSkill({ name, description: s.description, body: s.body, extra: s.extra, files: s.files, skipped: s.skipped, source: s.source, enabled: false, accounts: choices.accounts });
    return { kind: "skill", id: saved.id, href: `#/settings/skills/${encodeURIComponent(saved.id)}` };
  }
  try {
    const input = importSharedFlow(item.flow, choices.answers);
    const made = await createFlow(input);
    return { kind: "flow", id: made.id, href: `#/flows/${encodeURIComponent(made.id)}` };
  } catch (error) {
    if (error instanceof Error && error.message === "not built yet") throw new Error("Athena can't add flows yet.");
    throw error;
  }
}

/** GET /api/community/updates: items added from the catalogue that have a newer version or were taken down. */
export async function checkUpdates(): Promise<UpdateCheck[]> {
  return notBuilt("checkUpdates");
}
