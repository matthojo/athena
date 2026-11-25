/**
 * Community, for the app: the calls the `#/community` and `#/add` screens make, and their routes. The shapes are
 * lib/community-api.ts; the server's side is netlify/lib/community-routes.ts (the catalogue, updates, the switch)
 * and netlify/lib/community-add-routes.ts (preview and add). Sample mode answers each call in the browser.
 *
 * Every way in ends at `#/add`, one preview screen:
 *   #/add?catalogue=<id>   a listing from the Community screen
 *   #/add?link=<url>       a github.com link someone sent
 *   #/add                  files: picked, dropped, or from the installed app's share target (held in memory)
 * `#/community` is the catalogue itself.
 */
import type { IntakeEntry } from "../../../lib/skills";
import type { AddChoices, AddPreview, AddResult, CatalogueView, CommunitySettings, UpdateCheck } from "../../../lib/community-api";
import { ApiError, getToken, isSampleMode, request } from "./api";
import { answersFor, buildPreview, itemFiles, NEWER_FORMAT_STATUS, sourceFor } from "../../../lib/community-add";
import { COMMUNITY_SITE, submitPageUrl, verifyBundle } from "../../../lib/catalogue-types";
import { importSharedFlow } from "../../../lib/flow-share";
import { grantedTools, ShareFormatError } from "../../../lib/team-share";
import { splitWouldLike } from "../../../lib/shared-limits";
import { MAX_ASSISTANTS } from "../../../lib/team-types";
import { rememberSampleAdd, sampleAddedFrom, sampleBundle } from "./sample-community";
import { sampleLinkFiles } from "../add/sample-items";
import { addImported } from "./team-share";
import { listTeam, teamChanged, updateAssistant } from "./team";
import { fetchSkill, fetchSkills, saveSkill } from "./skills";
import { flowsChanged, sampleAddSharedFlow, sampleReplaceSharedFlow } from "./flows";
import { checkinsChanged } from "./checkins";
import { templatesChanged } from "./documents";

export type { AddChoices, AddPreview, AddResult, CatalogueView, CommunitySettings, UpdateCheck };

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
  const view: CatalogueView = { configured, on, host: configured ? new URL(COMMUNITY_SITE).host : null, generated_at: null, items: [], added: [], error: null };
  if (!configured || !on) return view;
  if (state === "down") return { ...view, error: "Athena couldn't reach the Community catalogue." };
  const { sampleCatalogue, sampleAddedIds } = await import("./sample-community");
  const { sampleTemplateListings } = await import("./documents");
  const index = await sampleCatalogue();
  const items = [...index.items].sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
  return { ...view, generated_at: index.generated_at, items, added: [...new Set([...sampleAddedIds(), ...(await sampleTemplateListings()).map((t) => t.catalogue_id)])] };
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

/** GET /api/community/settings: the switch, whether a catalogue is set at all, and its page for sending an item in. */
export async function loadCommunityCheck(): Promise<CommunitySettings> {
  if (isSampleMode()) {
    const configured = store.get(SAMPLE_CATALOGUE_STATE) !== "none";
    return { on: store.get(SAMPLE_COMMUNITY_SWITCH) !== "off", configured, submit: configured ? submitPageUrl(COMMUNITY_SITE) : null };
  }
  return request<CommunitySettings>("/community/settings");
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
  // The lists that hold it follow, and an Update clears its "Update available".
  if (result.kind === "assistant") teamChanged();
  else if (result.kind === "flow") flowsChanged();
  else if (result.kind === "checkin") checkinsChanged();
  else if (result.kind === "template") templatesChanged();
  if (result.updated) forgetUpdates();
  return result;
}

/** Did it fail because the file was made for a newer Athena? (426 from the server, NewerFormatError in sample mode.) */
export const isNewerFormat = (error: unknown): boolean => (error as { status?: number } | null)?.status === NEWER_FORMAT_STATUS || (error as { newer?: boolean } | null)?.newer === true;

// ---------- sample mode: the same reading as the server's, with made-up items ----------

const utf8 = new TextEncoder();

async function samplePreview(source: AddSource): Promise<AddPreview> {
  const at = new Date().toISOString();
  if ("catalogue" in source) {
    const found = await sampleBundle(source.catalogue);
    if (!found) throw new ShareFormatError("That item isn't in the catalogue any more.");
    const { item, bundle } = found;
    if (!(await verifyBundle(bundle, item))) throw new ShareFormatError("That listing's files don't match what the catalogue says they are, so Athena won't use them.");
    const kind = item.kind;
    // A template is found among the templates here, as the catalogue_* columns would find it, and also says whether the
    // owner changed it since adding it: an Update then goes beside it.
    const listed = kind === "template" ? (await import("./documents").then((m) => m.sampleTemplateListings())).find((t) => t.catalogue_id === item.id) : undefined;
    const had = kind === "template" ? (listed ? { kind, id: listed.id, hash: listed.hash, version: listed.version } : null) : sampleAddedFrom(item.id);
    const existing = had && had.kind === kind ? { id: had.id, version: had.version, href: HREF[kind](had.id), newer: had.hash !== item.hash, ...(listed ? { changed: listed.changed } : {}) } : null;
    return await buildPreview({ files: { kind, files: bundle.files, skipped: [], folder: null }, from: { catalogue: item.id }, source: sourceFor({ catalogue: item.id }, at, COMMUNITY_SITE), listing: item, existing });
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
}

const HREF: Record<AddPreview["kind"], (id: string) => string> = {
  assistant: (id) => `#/team/${encodeURIComponent(id)}`,
  skill: (id) => `#/settings/skills/${encodeURIComponent(id)}`,
  flow: (id) => `#/flows/${encodeURIComponent(id)}`,
  checkin: () => "#/settings/checkins",
  template: (id) => `#/notes?template=${encodeURIComponent(id)}`,
};

async function sampleAdd(p: AddPreview, choices: AddChoices): Promise<AddResult> {
  const result = choices.replace ? await sampleReplace(p, choices, choices.replace) : await sampleAddNew(p, choices);
  if ("catalogue" in p.from) rememberSampleAdd(p.from.catalogue, { kind: result.kind, id: result.id, hash: p.hash, version: p.listing?.version ?? null });
  return result;
}

/** Sample mode's Update: as the server's, the one from that listing only, keeping its name, switched off. */
async function sampleReplace(p: AddPreview, choices: AddChoices, id: string): Promise<AddResult> {
  const had = "catalogue" in p.from ? sampleAddedFrom(p.from.catalogue) : null;
  if (!had || had.id !== id) throw new ShareFormatError("That isn't the one you added from this listing any more. Look at it again.");
  const item = p.item;
  if (item.kind === "assistant") {
    const w = item.shared;
    await updateAssistant(id, { job: w.job, instructions: w.instructions, allow: grantedTools(w, choices.allow), web: choices.web && w.web, accounts: choices.accounts, paused: true });
  } else if (item.kind === "skill") {
    const s = item.skill;
    const was = await fetchSkill(id);
    await saveSkill({ name: was?.name ?? s.name, description: s.description, body: s.body, extra: s.extra, files: s.files, skipped: s.skipped, enabled: false, accounts: choices.accounts }, id);
  } else if (item.kind === "checkin") {
    const { sampleReplaceCheckins } = await import("./sample-checkins");
    const got = await sampleReplaceCheckins(id, item.checkins, { id: p.listing!.id, hash: p.hash, version: p.listing?.version ?? null });
    forgetUpdates();
    return { kind: "checkin", id, href: HREF.checkin(id), updated: true, checkins: { added: got.added, skipped: got.skipped, off: got.off, full: got.full } };
  } else if (item.kind === "template") {
    const { sampleReplaceTemplate } = await import("./documents");
    const got = await sampleReplaceTemplate(id, item.template, { id: p.listing!.id, hash: p.hash, version: p.listing?.version ?? null });
    forgetUpdates();
    return { kind: "template", id: got.id, href: HREF.template(got.id), updated: true, template: { name: got.name, renamed: got.renamed, beside: got.beside } };
  } else await sampleReplaceSharedFlow(id, importSharedFlow(item.flow, choices.answers));
  forgetUpdates();
  return { kind: p.kind, id, href: HREF[p.kind](id), updated: true };
}

async function sampleAddNew(p: AddPreview, choices: AddChoices): Promise<AddResult> {
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
  if (item.kind === "checkin") {
    const { sampleAddCheckins } = await import("./sample-checkins");
    const listing = "catalogue" in p.from && p.listing ? { id: p.listing.id, hash: p.hash, version: p.listing.version } : undefined;
    const got = await sampleAddCheckins(item.checkins, listing, { start: choices.start !== false });
    return { kind: "checkin", id: got.id, href: HREF.checkin(got.id), checkins: { added: got.added, skipped: got.skipped, off: got.off, full: got.full } };
  }
  if (item.kind === "template") {
    const { sampleAddTemplate } = await import("./documents");
    const listing = "catalogue" in p.from && p.listing ? { id: p.listing.id, hash: p.hash, version: p.listing.version } : undefined;
    const got = await sampleAddTemplate(item.template, listing);
    return { kind: "template", id: got.id, href: HREF.template(got.id), template: { name: got.name, renamed: got.renamed, beside: false } };
  }
  const made = await sampleAddSharedFlow(importSharedFlow(item.flow, choices.answers));
  return { kind: "flow", id: made.id, href: `#/flows/${encodeURIComponent(made.id)}` };
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
      : Promise.all([import("./sample-community"), import("./documents")]).then(async ([m, d]) => m.sampleUpdates(await d.sampleTemplateListings()))
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
