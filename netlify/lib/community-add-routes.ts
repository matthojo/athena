/**
 * Community: adding something someone shared, from the `#/add` screen (app/src/add/). Shapes: lib/community-api.ts.
 *
 *   POST /api/community/preview  { catalogue } | { link }, or multipart files (field `files`, each with a `path`)
 *                                → { preview: AddPreview }. Nothing is kept.
 *   POST /api/community/add      { preview, choices } → AddResult (201). Added switched off. With `choices.replace`,
 *                                the one already added from that listing is updated instead (200), switched off too.
 *
 * Every way in ends at the same preview (lib/community-add.ts buildPreview): the kind from the files, each read by
 * its own reader (an assistant by lib/team-share.ts, a skill by lib/skills.ts, a flow by lib/flow-share.ts), its
 * reach and hash worked out here. A catalogue bundle is checked against its hash and the index's first
 * (verifyBundle). A link is GitHub only and read once, through the same guard as skill links.
 *
 * The server never trusts the preview the app sends back. On Add it reads the files again (for a catalogue item,
 * the bundle again, refused if it changed since the preview), works out kind, reach and hash again, and hands the
 * item to its kind's own import with only the owner's choices:
 *
 * - an assistant: lib/team-share-store.ts importAssistant: paused, ticked tools it asked for that an import may
 *   grant, web only when asked for and ticked, ticked accounts only;
 * - a skill: lib/skills-store.ts createSkill: off (an imported skill always starts off), ticked accounts only;
 * - a flow: lib/flow-share-store.ts addSharedFlow: paused, blanks filled from the answers.
 *
 * Add never overwrites by itself: the preview says "You already have this" when an item came from the same listing,
 * and only an explicit `replace` naming that item updates it (its name and history stay, its content becomes the new
 * version's, and it goes off). Otherwise a second copy is added beside it. Behind the same bearer token as the rest
 * of the API.
 */
import { CatalogueError, verifyBundle, type CatalogueBundle, type CatalogueItem } from "../../lib/catalogue-types";
import type { AddChoices, AddPreview, AddRequest, AddResult } from "../../lib/community-api";
import { answersFor, buildPreview, filesFromApp, itemFiles, NEWER_FORMAT_STATUS, NewerFormatError, sourceFor, type ItemFiles } from "../../lib/community-add";
import { detectKind, type ShareKind } from "../../lib/share-kinds";
import { SkillFormatError, SKILL_LIMITS, type IntakeEntry, type SkillSource } from "../../lib/skills";
import { parseShareLink, ShareFormatError, type ImportInput, type SharedSkill } from "../../lib/team-share";
import type { FlowAnswers, SharedFlow } from "../../lib/flow-share";
import { cleanAccountIds } from "../../lib/shared-limits";

type Json = (data: unknown, status?: number) => Response;

/** 2 MB of files, and the form around them. */
export const MAX_PREVIEW_BODY = SKILL_LIMITS.uploadBytes + 200_000;
/** The preview sent back with Add: its files (500 KB at most as the catalogue counts them), escaped, and the rest. */
export const MAX_ADD_BODY = 2_500_000;
const MAX_FILES = 500;

/** What the routes reach outside themselves: the live ones below, fakes in tests. */
export interface CommunityAddDeps {
  /** A listing and its bundle (netlify/lib/community-catalogue.ts). */
  loadBundle: (id: string) => Promise<{ item: CatalogueItem; bundle: CatalogueBundle }>;
  /** A public GitHub folder's files, read once through the link guard. */
  fetchLink: (url: string) => Promise<IntakeEntry[]>;
  /** The catalogue's address, recorded as an added skill's source. */
  catalogueAddress: () => string | null;
  /** An item of this kind here added from the same listing, with the hash of what was added. */
  existing: (kind: ShareKind, catalogueId: string) => Promise<{ id: string; version: string | null; hash: string | null } | null>;
  addAssistant: (input: ImportInput) => Promise<{ id: string; writing: Promise<unknown> | null }>;
  addSkill: (input: { name: string; description: string; body: string; extra: string; files: SharedSkill["files"]; skipped: SharedSkill["skipped"]; source: SkillSource; enabled: false; accounts: string[] }) => Promise<{ id: string }>;
  addFlow: (shared: SharedFlow, answers: FlowAnswers, catalogue?: { id: string; hash: string; version?: string }) => Promise<{ id: string }>;
  /** Update one added from the catalogue to a newer version, as the add for its kind would, keeping its name. */
  replaceAssistant: (id: string, input: ImportInput) => Promise<{ writing: Promise<unknown> | null }>;
  replaceSkill: (id: string, input: { description: string; body: string; extra: string; files: SharedSkill["files"]; skipped: SharedSkill["skipped"]; accounts: string[] }) => Promise<void>;
  replaceFlow: (id: string, shared: SharedFlow, answers: FlowAnswers, catalogue: { id: string; hash: string; version?: string }) => Promise<void>;
  /** Record the listing an assistant or skill came from (migration 0088). Flows record their own. */
  markCatalogue: (kind: "assistant" | "skill", id: string, listing: { id: string; hash: string; version: string | null }) => Promise<void>;
  now: () => Date;
}

/** The server's own: the stores, the catalogue and the link guard. Loaded on first use, so tests never touch them. */
export async function liveDeps(): Promise<CommunityAddDeps> {
  const [{ loadBundle }, { fetchGithubFolder }, { catalogueUrl }, { q }, { importAssistant, updateImportedAssistant }, { createSkill, updateSkill, listSkills, freeName }, { addSharedFlow, replaceSharedFlow }] = await Promise.all([
    import("./community-catalogue"),
    import("../../lib/skill-fetch"),
    import("../../lib/community-config"),
    import("../../lib/db"),
    import("../../lib/team-share-store"),
    import("../../lib/skills-store"),
    import("../../lib/flow-share-store"),
  ]);
  const TABLE = { assistant: "team_assistants", skill: "ask_skills", flow: "flows" } as const;
  return {
    loadBundle,
    fetchLink: (url) => fetchGithubFolder(parseAddLink(url)),
    catalogueAddress: () => catalogueUrl() || null,
    existing: async (kind, catalogueId) => {
      const skillOnly = kind === "skill" ? " AND assistant_id IS NULL" : "";
      const [row] = await q<{ id: string; catalogue_version: string | null; catalogue_hash: string | null }>(`SELECT id::text AS id, catalogue_version, catalogue_hash FROM ${TABLE[kind]} WHERE catalogue_id = $1${skillOnly} ORDER BY created_at DESC LIMIT 1`, [catalogueId]);
      return row ? { id: row.id, version: row.catalogue_version, hash: row.catalogue_hash } : null;
    },
    addAssistant: async (input) => {
      const { assistant, writing } = await importAssistant(input as unknown as Record<string, unknown>);
      return { id: assistant.id, writing };
    },
    addSkill: async (input) => {
      // A name already in use gets a number, as an assistant's own skill does: Add never stops on a name.
      const taken = new Set((await listSkills()).map((s) => s.name));
      return createSkill({ ...input, name: freeName(input.name, taken) });
    },
    addFlow: addSharedFlow,
    replaceAssistant: async (id, input) => ({ writing: (await updateImportedAssistant(id, input as unknown as Record<string, unknown>)).writing }),
    replaceSkill: async (id, input) => void (await updateSkill(id, { ...input, enabled: false })),
    replaceFlow: async (id, shared, answers, catalogue) => void (await replaceSharedFlow(id, shared, answers, catalogue)),
    markCatalogue: async (kind, id, l) => {
      await q(`UPDATE ${TABLE[kind]} SET catalogue_id = $2, catalogue_hash = $3, catalogue_version = $4 WHERE id = $1::uuid`, [id, l.id, l.hash, l.version]);
    },
    now: () => new Date(),
  };
}

// ---------- links ----------

/**
 * A link to something shared: a GitHub folder, or a file in it (assistant.json, SKILL.md or flow.json, read as its
 * folder), on github.com or raw.githubusercontent.com. Anything else is refused, so a shared item can't point
 * Athena at someone's own site. Throws ShareFormatError. Pure.
 */
export function parseAddLink(raw: string) {
  // lib/team-share.ts reads a link to assistant.json or SKILL.md as its folder; a flow.json is read the same way.
  const asFolder = raw.trim().replace(/\/flow\.json(?=$|[?#])/i, "/SKILL.md");
  try {
    return parseShareLink(asFolder);
  } catch (error) {
    if (!(error instanceof ShareFormatError)) throw error;
    let host = "";
    try {
      host = new URL(raw.trim()).hostname.toLowerCase();
    } catch {
      // not a link at all: the reader's words say so
    }
    if (host && host !== "github.com" && host !== "www.github.com" && host !== "raw.githubusercontent.com") throw new ShareFormatError("Athena adds things from GitHub links only. For anything else, download it and add the file.");
    throw new ShareFormatError(error.message.replace("Link to the assistant's folder on GitHub, or to its assistant.json.", "Link to its folder on GitHub, or to the assistant.json, SKILL.md or flow.json in it.").replace("an assistant on GitHub", "anything on GitHub"));
  }
}

// ---------- previews ----------

const HREF: Record<ShareKind, (id: string) => string> = {
  assistant: (id) => `#/team/${encodeURIComponent(id)}`,
  skill: (id) => `#/settings/skills/${encodeURIComponent(id)}`,
  flow: (id) => `#/flows/${encodeURIComponent(id)}`,
};

const fromCatalogue = (bundle: CatalogueBundle): ItemFiles => {
  const kind = detectKind(bundle.files.map((f) => f.path));
  if (!kind) throw new ShareFormatError("That listing's files aren't an assistant, a skill or a flow.");
  return { kind, files: bundle.files, skipped: [], folder: null };
};

async function catalogueBundle(id: string, deps: CommunityAddDeps): Promise<{ item: CatalogueItem; bundle: CatalogueBundle }> {
  const got = await deps.loadBundle(id);
  if (!(await verifyBundle(got.bundle, got.item))) throw new CatalogueError("That listing's files don't match what the catalogue says they are, so Athena won't use them.");
  return got;
}

/** A listing, a link, or files: the preview. Nothing is kept. Throws ShareFormatError or CatalogueError. */
export async function previewOf(req: AddRequest | { files: IntakeEntry[]; name?: string }, deps: CommunityAddDeps): Promise<AddPreview> {
  const at = deps.now().toISOString();
  if ("catalogue" in req) {
    const id = String(req.catalogue).trim();
    const { item, bundle } = await catalogueBundle(id, deps);
    const had = await deps.existing(item.kind, item.id);
    const existing = had ? { id: had.id, version: had.version, href: HREF[item.kind](had.id), newer: had.hash !== item.hash } : null;
    return buildPreview({ files: fromCatalogue(bundle), from: { catalogue: item.id }, source: sourceFor({ catalogue: item.id }, at, deps.catalogueAddress()), listing: item, existing });
  }
  if ("link" in req) {
    const url = String(req.link).trim().slice(0, 2048);
    parseAddLink(url);
    let entries: IntakeEntry[];
    try {
      entries = await deps.fetchLink(url);
    } catch (error) {
      if (error instanceof SkillFormatError) throw new ShareFormatError(error.message);
      throw error;
    }
    return buildPreview({ files: itemFiles(entries), from: { link: url }, source: sourceFor({ link: url }, at) });
  }
  const files = itemFiles(req.files);
  const name = (req.name || files.folder || req.files[0]?.path.split("/")[0] || "").slice(0, 200);
  return buildPreview({ files, from: { files: name }, source: sourceFor({ files: name }, at) });
}

// ---------- adding ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);

/** The owner's choices as sent: only the shapes, never more than a preview could offer. Pure. */
export function readChoices(raw: unknown): AddChoices {
  const c = isObj(raw) ? raw : {};
  const answers: Record<string, string> = {};
  if (isObj(c.answers)) for (const [k, v] of Object.entries(c.answers).slice(0, 40)) if (typeof v === "string" && k.length <= 400) answers[k] = v.slice(0, 2000);
  return {
    answers,
    accounts: cleanAccountIds(c.accounts),
    allow: strings(c.allow, 40),
    web: c.web === true,
    money: c.money === true,
    assistant_id: typeof c.assistant_id === "string" ? c.assistant_id.slice(0, 64) : null,
    replace: typeof c.replace === "string" ? c.replace.slice(0, 64) : null,
  };
}

function fromOf(raw: unknown): AddPreview["from"] {
  if (isObj(raw)) {
    if (typeof raw.catalogue === "string") return { catalogue: raw.catalogue.slice(0, 64) };
    if (typeof raw.link === "string") return { link: raw.link.slice(0, 2048) };
    if (typeof raw.files === "string") return { files: raw.files.slice(0, 200) };
  }
  throw new ShareFormatError("That didn't arrive whole. Look at it again, then add it.");
}

/**
 * Add what the owner looked at: its files read again (a listing's bundle fetched and checked again, refused when it
 * changed since), then handed to its kind's own import with only the owner's choices. Switched off. Throws
 * ShareFormatError or CatalogueError. The second value is an assistant's skill still being written, if any.
 */
export async function addFrom(body: unknown, deps: CommunityAddDeps): Promise<{ result: AddResult; writing: Promise<unknown> | null }> {
  const b = isObj(body) ? body : {};
  const sent = isObj(b.preview) ? b.preview : {};
  const choices = readChoices(b.choices);
  const from = fromOf(sent.from);
  const at = deps.now().toISOString();
  let preview: AddPreview;
  let listing: CatalogueItem | null = null;
  if ("catalogue" in from) {
    const got = await catalogueBundle(from.catalogue, deps);
    if (typeof sent.hash !== "string" || got.bundle.hash !== sent.hash) throw new ShareFormatError("That listing changed in the catalogue since you looked. Look at it again, then add it.");
    listing = got.item;
    preview = await buildPreview({ files: fromCatalogue(got.bundle), from, source: sourceFor(from, at, deps.catalogueAddress()), listing });
  } else {
    preview = await buildPreview({ files: filesFromApp(sent.files), from, source: sourceFor(from, at) });
    if (typeof sent.hash === "string" && sent.hash !== preview.hash) throw new ShareFormatError("That didn't arrive whole. Look at it again, then add it.");
  }
  const mark = listing ? { id: listing.id, hash: preview.hash, version: listing.version } : null;
  const item = preview.item;
  if (choices.replace) return replaceFrom(choices.replace, preview, choices, listing, from, at, deps);
  if (item.kind === "assistant") {
    const { id, writing } = await deps.addAssistant({
      shared: item.shared,
      skill: item.skill,
      source: sourceFor(from, at, deps.catalogueAddress()),
      answers: answersFor(item.shared.asks, choices.answers),
      // Only ticked tools it asked for count, and only those an import may grant (lib/shared-limits.ts): importAssistant checks.
      allow: choices.allow,
      web: choices.web && item.shared.web,
      accounts: choices.accounts,
    });
    if (mark) await deps.markCatalogue("assistant", id, mark);
    return { result: { kind: "assistant", id, href: HREF.assistant(id) }, writing };
  }
  if (item.kind === "skill") {
    const s = item.skill;
    const { id } = await deps.addSkill({ name: s.name, description: s.description, body: s.body, extra: s.extra, files: s.files, skipped: s.skipped, source: s.source, enabled: false, accounts: choices.accounts });
    if (mark) await deps.markCatalogue("skill", id, mark);
    return { result: { kind: "skill", id, href: HREF.skill(id) }, writing: null };
  }
  const { id } = await deps.addFlow(item.flow, flowAnswers(item.flow, choices), mark ? { id: mark.id, hash: mark.hash, ...(mark.version ? { version: mark.version } : {}) } : undefined);
  return { result: { kind: "flow", id, href: HREF.flow(id) }, writing: null };
}

/**
 * Update the one already added from this listing to the version just read (the owner tapped Update): only that one,
 * found again here whatever the app says, and only from the catalogue. Its kind's own update keeps its name and
 * history and switches it off. Throws ShareFormatError.
 */
async function replaceFrom(id: string, preview: AddPreview, choices: AddChoices, listing: CatalogueItem | null, from: AddPreview["from"], at: string, deps: CommunityAddDeps): Promise<{ result: AddResult; writing: Promise<unknown> | null }> {
  if (!listing) throw new ShareFormatError("Only something added from Community can be updated. Add it as a new one instead.");
  const had = await deps.existing(preview.kind, listing.id);
  if (!had || had.id !== id) throw new ShareFormatError("That isn't the one you added from this listing any more. Look at it again.");
  const mark = { id: listing.id, hash: preview.hash, version: listing.version };
  const item = preview.item;
  const done = (writing: Promise<unknown> | null) => ({ result: { kind: preview.kind, id, href: HREF[preview.kind](id), updated: true }, writing });
  if (item.kind === "assistant") {
    const { writing } = await deps.replaceAssistant(id, {
      shared: item.shared,
      skill: item.skill,
      source: sourceFor(from, at, deps.catalogueAddress()),
      answers: answersFor(item.shared.asks, choices.answers),
      allow: choices.allow,
      web: choices.web && item.shared.web,
      accounts: choices.accounts,
    });
    await deps.markCatalogue("assistant", id, mark);
    return done(writing);
  }
  if (item.kind === "skill") {
    const s = item.skill;
    await deps.replaceSkill(id, { description: s.description, body: s.body, extra: s.extra, files: s.files, skipped: s.skipped, accounts: choices.accounts });
    await deps.markCatalogue("skill", id, mark);
    return done(null);
  }
  await deps.replaceFlow(id, item.flow, flowAnswers(item.flow, choices), { id: mark.id, hash: mark.hash, ...(mark.version ? { version: mark.version } : {}) });
  return done(null);
}

/** A flow's answers by key, every question answered. Throws ShareFormatError naming the first left. */
function flowAnswers(flow: SharedFlow, choices: AddChoices): FlowAnswers {
  const answers: FlowAnswers = {};
  for (const a of flow.asks) {
    const v = choices.answers[a.key];
    if (typeof v === "string" && v.trim()) answers[a.key] = v.trim();
  }
  const missing = flow.asks.filter((a) => !answers[a.key]);
  if (missing.length) throw new ShareFormatError(`Answer “${missing[0].question}” first.`);
  return answers;
}

// ---------- the routes ----------

/** Multipart files as entries: each `files` part, its path from the matching `path` field (else its name). */
async function filesFromForm(req: Request, max: number): Promise<{ entries: IntakeEntry[]; name: string } | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  let form: FormData;
  try {
    form = await new Response(all, { headers: { "Content-Type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ShareFormatError("That didn't arrive whole. Try again.");
  }
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
  const paths = form.getAll("path").map(String);
  if (!files.length) throw new ShareFormatError("Send a shared item's files, a listing or a GitHub link.");
  if (files.length > MAX_FILES) throw new ShareFormatError("That folder has too many files for one shared item.");
  const entries = await Promise.all(files.map(async (f, i) => ({ path: (paths[i] || f.name).slice(0, 300), bytes: new Uint8Array(await f.arrayBuffer()) })));
  const name = String(form.get("name") ?? "").slice(0, 200);
  // One zip: its files, read through the same reader as a skill's (central directory, caps, text only).
  if (entries.length === 1 && isZip(entries[0].bytes)) {
    const { readSkillZip } = await import("../../lib/skill-zip");
    try {
      return { entries: readSkillZip(entries[0].bytes), name: name || entries[0].path.replace(/\.zip$/i, "") };
    } catch (error) {
      if (error instanceof SkillFormatError) throw new ShareFormatError(error.message.replace("A skill is mostly text", "A shared item is mostly text"));
      throw error;
    }
  }
  return { entries, name };
}

async function jsonUpTo(req: Request, max: number): Promise<Record<string, unknown> | null> {
  const { textUpTo } = await import("./body-limit");
  const text = await textUpTo(req, max);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    return isObj(parsed) ? parsed : {};
  } catch {
    throw new ShareFormatError("That didn't arrive whole. Try again.");
  }
}

/** A zip starts "PK\x03\x04" (or "PK\x05\x06" when empty). */
const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);

const TOO_BIG = "That's over 2 MB. A shared item is mostly text: leave out large files.";

/** POST /api/community/preview and /api/community/add. Null for anything else under /api/community. */
export async function handleCommunityAddRoutes(
  req: Request,
  segments: string[],
  json: Json,
  opts: { deps?: CommunityAddDeps | (() => Promise<CommunityAddDeps>); waitUntil?: (p: Promise<unknown>) => void } = {},
): Promise<Response | null> {
  // ["api", "community", "preview" | "add"]
  const [, first, second] = segments;
  if (first !== "community" || (second !== "preview" && second !== "add") || segments.length !== 3) return null;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const deps = typeof opts.deps === "function" ? await opts.deps() : (opts.deps ?? (await liveDeps()));
  try {
    if (second === "preview") {
      if (/^multipart\/form-data/i.test(req.headers.get("content-type") ?? "")) {
        const got = await filesFromForm(req, MAX_PREVIEW_BODY);
        if (!got) return json({ error: TOO_BIG }, 413);
        return json({ preview: await previewOf({ files: got.entries, name: got.name }, deps) });
      }
      const body = await jsonUpTo(req, 10_000);
      if (!body) return json({ error: TOO_BIG }, 413);
      if (typeof body.catalogue === "string" && body.catalogue.trim()) return json({ preview: await previewOf({ catalogue: body.catalogue }, deps) });
      if (typeof body.link === "string" && body.link.trim()) return json({ preview: await previewOf({ link: body.link }, deps) });
      return json({ error: "Send a listing, a GitHub link or a shared item's files." }, 400);
    }
    const body = await jsonUpTo(req, MAX_ADD_BODY);
    if (!body) return json({ error: TOO_BIG }, 413);
    const { result, writing } = await addFrom(body, deps);
    if (writing) opts.waitUntil?.(writing);
    return json(result, result.updated ? 200 : 201);
  } catch (error) {
    if (error instanceof NewerFormatError) return json({ error: error.message, newer: true }, NEWER_FORMAT_STATUS);
    if (error instanceof ShareFormatError || error instanceof SkillFormatError) return json({ error: error.message }, 400);
    if (error instanceof CatalogueError) return json({ error: error.message }, 502);
    if (error instanceof Error && error.name === "AthenaInputError") return json({ error: error.message }, (error as Error & { status?: number }).status ?? 400);
    throw error;
  }
}
