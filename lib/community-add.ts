/**
 * Community: the one preview every way in ends at (`#/add`), worked out from an item's files. Pure and shared by
 * the server (netlify/lib/community-add-routes.ts) and sample mode (app/src/db/community.ts), so both read a file
 * the same way.
 *
 * - `itemFiles`: a folder's, zip's or link's files, cut down to the item's own: the folder holding the file that
 *   names its kind, text files only, within the catalogue's caps. Everything else is listed as not used.
 * - `buildPreview`: those files read by the reader for their kind (readShared, intakeEntries, readSharedFlow), with
 *   their reach and hash worked out here. Nothing is kept, and nothing in a file is a permission.
 *
 * A file made for a newer Athena throws NewerFormatError, so the screen can say "Update Athena to add this".
 */
import { bundleHash, CATALOGUE_LIMITS, KIND_FORMATS, type CatalogueFile, type CatalogueItem } from "./catalogue-types";
import type { AddPreview, AddPreviewItem } from "./community-api";
import { checkSharedFlowSteps, readSharedFlow } from "./flow-share";
import { reachOf } from "./reach";
import { detectKind, KIND_FILES, kindOfFile, readHeader, type ShareHeader, type ShareKind } from "./share-kinds";
import { cleanPath, intakeEntries, NOT_USED_BIG, NOT_USED_FULL, NOT_USED_SCRIPT, NOT_USED_UNREAD, SKILL_LIMITS, SkillFormatError, skillTitle, textOf, TEXT_EXTENSIONS, type IntakeEntry, type SkillSource } from "./skills";
import { bundleFromEntries, ShareFormatError, type SharedAsk } from "./team-share";
import type { TeamAnswer } from "./team-skill";

/** HTTP status for a file made for a newer Athena: 426, Upgrade Required. */
export const NEWER_FORMAT_STATUS = 426;

/** The file was made for a newer Athena than this one. */
export class NewerFormatError extends ShareFormatError {
  readonly newer = true as const;
  constructor(kind: ShareKind) {
    super(`That ${kind} was made for a newer Athena. Update Athena to add it.`);
    this.name = "NewerFormatError";
  }
}

const KIND_WORDS: Record<ShareKind, string> = { assistant: "assistant", skill: "skill", flow: "flow" };
const hidden = (path: string) => path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX");
const depthOf = (path: string) => path.split("/").length;
const extOf = (path: string) => {
  const name = path.split("/").pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
};
const utf8 = new TextEncoder();

export interface ItemFiles {
  kind: ShareKind;
  /** Relative to the item's folder: "flow.json", "SKILL.md", "references/prices.csv". */
  files: CatalogueFile[];
  /** Files beside it that aren't kept, with why. */
  skipped: Array<{ path: string; reason: string }>;
  /** The folder it was in, if any: "gift-price-watcher". */
  folder: string | null;
}

/**
 * The item in a folder's, zip's or link's files: the shallowest file naming a kind, and the text files beside and
 * under it, as the catalogue would bundle them. Scripts, binaries and anything over a cap are listed, never kept.
 * Throws ShareFormatError when nothing names a kind, or two items sit side by side. Pure.
 */
export function itemFiles(entries: readonly IntakeEntry[]): ItemFiles {
  const clean = entries.flatMap((e) => {
    const path = cleanPath(e.path);
    return path && !hidden(path) ? [{ ...e, path }] : [];
  });
  if (clean.reduce((n, e) => n + e.bytes.byteLength, 0) > SKILL_LIMITS.uploadBytes) throw new ShareFormatError("That's over 2 MB. A shared item is mostly text: leave out large files.");
  // One file on its own, renamed on the way ("flow (1).json", "gift-watch.json", "tea.md"): read by what it holds.
  if (clean.length === 1 && !kindOfFile(clean[0].path)) {
    const named = loneFileName(clean[0]);
    if (named) clean[0] = { ...clean[0], path: clean[0].path.split("/").slice(0, -1).concat(named).join("/") };
  }
  const kind = detectKind(clean.map((e) => e.path));
  if (!kind) {
    if (clean.some((e) => kindOfFile(e.path))) throw new ShareFormatError("That holds a flow and a skill side by side. Add them one at a time, from their own folders.");
    throw new ShareFormatError("There's no assistant.json, SKILL.md or flow.json in that.");
  }
  const mains = clean.filter((e) => kindOfFile(e.path) === kind).sort((a, b) => depthOf(a.path) - depthOf(b.path));
  const top = depthOf(mains[0].path);
  if (mains.filter((e) => depthOf(e.path) === top).length > 1) throw new ShareFormatError(`That holds more than one ${KIND_WORDS[kind]}. Add them one at a time.`);
  const folder = mains[0].path.split("/").slice(0, -1).join("/");
  const files: CatalogueFile[] = [];
  const skipped: ItemFiles["skipped"] = [];
  let total = 0;
  for (const e of clean) {
    if (folder && !e.path.startsWith(`${folder}/`)) continue;
    const path = folder ? e.path.slice(folder.length + 1) : e.path;
    const main = e === mains[0];
    const size = e.size ?? e.bytes.byteLength;
    const text = (TEXT_EXTENSIONS as readonly string[]).includes(extOf(path)) && size <= CATALOGUE_LIMITS.fileBytes && !e.unread ? textOf(e.bytes) : null;
    if (main && text === null) throw new ShareFormatError(`${KIND_FILES[kind]} isn't readable text, or it's over 100 KB.`);
    if (e.unread) skipped.push({ path, reason: NOT_USED_UNREAD });
    else if (!(TEXT_EXTENSIONS as readonly string[]).includes(extOf(path))) skipped.push({ path, reason: NOT_USED_SCRIPT });
    else if (size > CATALOGUE_LIMITS.fileBytes) skipped.push({ path, reason: NOT_USED_BIG });
    else if (text === null) skipped.push({ path, reason: NOT_USED_UNREAD });
    else if (!main && (files.length >= CATALOGUE_LIMITS.files - 1 || total + utf8.encode(text).length > CATALOGUE_LIMITS.totalBytes)) skipped.push({ path, reason: NOT_USED_FULL });
    else {
      files.push({ path: main ? KIND_FILES[kind] : path, text });
      total += utf8.encode(text).length;
    }
  }
  files.sort((a, b) => (a.path === KIND_FILES[kind] ? -1 : b.path === KIND_FILES[kind] ? 1 : a.path.localeCompare(b.path)));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { kind, files, skipped, folder: folder ? folder.split("/").pop()! : null };
}

/** What a lone file is, by what it holds: flow.json (a trigger and steps), assistant.json (a job), SKILL.md (front matter). */
function loneFileName(e: IntakeEntry): string | null {
  const ext = extOf(e.path);
  if (e.bytes.byteLength > CATALOGUE_LIMITS.fileBytes || (ext !== ".json" && ext !== ".md")) return null;
  const text = textOf(e.bytes);
  if (text === null) return null;
  if (ext === ".md") return /^\uFEFF?---\s*\n/.test(text) ? KIND_FILES.skill : null;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    if ("steps" in o && "trigger" in o) return KIND_FILES.flow;
    if ("job" in o) return KIND_FILES.assistant;
  } catch {
    // not JSON: the usual words say so
  }
  return null;
}

/** Files the app sent back with Add, checked again as files: paths, text, caps. Throws ShareFormatError. Pure. */
export function filesFromApp(raw: unknown): ItemFiles {
  if (!Array.isArray(raw) || !raw.length) throw new ShareFormatError("That didn't arrive whole. Look at it again, then add it.");
  if (raw.length > CATALOGUE_LIMITS.files) throw new ShareFormatError(`A shared item has ${CATALOGUE_LIMITS.files} files at most.`);
  const entries: IntakeEntry[] = raw.map((f) => {
    const path = (f as { path?: unknown })?.path;
    const text = (f as { text?: unknown })?.text;
    if (typeof path !== "string" || typeof text !== "string") throw new ShareFormatError("That didn't arrive whole. Look at it again, then add it.");
    return { path: path.slice(0, 260), bytes: utf8.encode(text) };
  });
  return itemFiles(entries);
}

/** The bytes again, for the readers that take a folder's entries. */
const entriesOf = (files: readonly CatalogueFile[]): IntakeEntry[] => files.map((f) => ({ path: f.path, bytes: utf8.encode(f.text) }));

const mainText = (kind: ShareKind, files: readonly CatalogueFile[]) => files.find((f) => f.path === KIND_FILES[kind])?.text ?? "";

function parseJson(text: string, file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    throw new ShareFormatError(`${file} isn't valid JSON.`);
  }
}

/** Throws NewerFormatError when the file says it's a newer format than this Athena reads. Pure. */
export function checkFormat(kind: ShareKind, files: readonly CatalogueFile[]): void {
  if (kind === "skill") return;
  const format = parseJson(mainText(kind, files), KIND_FILES[kind]).format;
  if (typeof format === "number" && format > KIND_FORMATS[kind]) throw new NewerFormatError(kind);
}

/** What the file is, read by its kind's own reader. Throws ShareFormatError. Pure. */
export function readItem(kind: ShareKind, files: readonly CatalogueFile[], source: SkillSource): AddPreviewItem {
  try {
    if (kind === "assistant") {
      const b = bundleFromEntries(entriesOf(files), source);
      return { kind, shared: b.shared, skill: b.skill };
    }
    if (kind === "skill") return { kind, skill: intakeEntries(entriesOf(files), source) };
    const flow = readSharedFlow(parseJson(mainText(kind, files), KIND_FILES.flow));
    checkSharedFlowSteps(flow);
    return { kind, flow };
  } catch (error) {
    if (error instanceof SkillFormatError) throw new ShareFormatError(error.message);
    throw error;
  }
}

/** The name, summary and header the screen leads with. Pure. */
export function describe(item: AddPreviewItem): { name: string; summary: string; header: ShareHeader } {
  if (item.kind === "assistant") {
    const w = item.shared;
    return { name: w.name || w.job, summary: w.summary || (w.name ? w.job : ""), header: readHeader(w as unknown as Record<string, unknown>) };
  }
  if (item.kind === "skill") return { name: skillTitle(item.skill.name), summary: item.skill.description, header: {} };
  return { name: item.flow.name, summary: item.flow.summary, header: readHeader(item.flow as unknown as Record<string, unknown>) };
}

export interface PreviewInput {
  files: ItemFiles;
  from: AddPreview["from"];
  /** Where a skill or assistant's skill records it came from. */
  source: SkillSource;
  /** For a catalogue item: its listing. Its kind must match the files. */
  listing?: Pick<CatalogueItem, "id" | "kind" | "version" | "featured" | "added_at" | "author"> | null;
  existing?: AddPreview["existing"];
}

/**
 * Everything the `#/add` screen shows, from the files alone: kind, what they say, reach, hash. The catalogue's or
 * author's word for any of it is never used. Throws ShareFormatError (NewerFormatError for a newer file). Pure.
 */
export async function buildPreview(input: PreviewInput): Promise<AddPreview> {
  const { kind, files, skipped } = input.files;
  if (input.listing && input.listing.kind !== kind) throw new ShareFormatError(`That's listed as a ${input.listing.kind}, but its files are a ${kind}.`);
  checkFormat(kind, files);
  const item = readItem(kind, files, input.source);
  const reach = reachOf({ kind, files });
  const more = item.kind === "skill" ? item.skill.skipped : item.kind === "assistant" ? (item.skill?.skipped ?? []) : [];
  const allSkipped = [...skipped, ...more.filter((s) => !skipped.some((x) => x.path === s.path || x.path.endsWith(`/${s.path}`)))];
  return {
    kind,
    item,
    ...describe(item),
    reach,
    files: [...files],
    hash: await bundleHash(files),
    from: input.from,
    listing: input.listing ? { id: input.listing.id, version: input.listing.version, featured: input.listing.featured, added_at: input.listing.added_at, author: input.listing.author ?? null } : null,
    existing: input.existing ?? null,
    skipped: allSkipped,
  };
}

/** Answers keyed by question, as an assistant's skill takes them: only its own questions, trimmed. Pure. */
export function answersFor(asks: readonly SharedAsk[], answers: Record<string, string> | undefined): TeamAnswer[] {
  const out: TeamAnswer[] = [];
  for (const a of asks) {
    const v = answers?.[a.question];
    if (typeof v === "string" && v.trim()) out.push({ question: a.question, answer: v.replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  return out;
}

/** Where it came from, as a skill's source records it. Pure. */
export function sourceFor(from: AddPreview["from"], at: string, catalogueAddress?: string | null): SkillSource {
  if ("link" in from) return { kind: "link", url: from.link, at };
  if ("catalogue" in from) return { kind: "link", ...(catalogueAddress ? { url: catalogueAddress } : {}), at };
  return { kind: "upload", ...(from.files ? { file: from.files.slice(0, 200) } : {}), at };
}
