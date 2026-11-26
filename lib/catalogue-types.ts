/**
 * Community: the catalogue's files. The catalogue is a separate repository of reviewed items, served as static
 * files. Athena's own server reads three kinds of file from it, and the browser never contacts it:
 *
 *   index.json                 CatalogueIndex: every listed item, and the ids taken down
 *   index.json.sig             index.json's Ed25519 signature, base64, checked once CATALOGUE_SIGNING_KEYS lists a key
 *   <item.bundle>              CatalogueBundle: one item's files, as text, with their hash
 *
 * In the catalogue repository, each item's folder also holds listing.json (a Listing): the id minted for it when
 * it was first accepted, so renaming or moving the folder keeps the id. Its build writes index.json and the
 * bundles from the folders.
 *
 * Everything here is pure and shared by the server, the app and the catalogue's build. The validators refuse a
 * file over its byte or count caps before reading further. A field this Athena knows that doesn't fit its type,
 * size or count refuses the file whole, since the catalogue is meant to be right.
 *
 * Reading is tolerant of what's new: a key this Athena doesn't know, on the index, an item, its reach, a withdrawn
 * entry, a bundle, a bundle's file or a listing, is dropped, never kept or passed on. So the directory site can add a
 * field without every older copy refusing the whole catalogue. A change older copies must not read past goes in
 * `format` or an item's `min_format`, never in a new key. The bundle hash covers each file's path and text only.
 *
 * An item of a kind this Athena doesn't know is skipped and the rest of the index is read, so the directory can list
 * a new kind before every copy has updated. Only a kind that's a word (`kind` a string) is skipped: anything else
 * about the item that doesn't fit still refuses the index, and so does a known kind that doesn't fit.
 */
import { z } from "zod";
import { SHARE_FORMAT } from "./team-share";
import { FLOW_SHARE_FORMAT } from "./flow-share";
import { CHECKIN_SHARE_FORMAT } from "./checkin-share";
import { TEMPLATE_SHARE_FORMAT } from "./template-share";
import { THEME_SHARE_FORMAT } from "./theme-share";
import { detectKind, KIND_FILES, SHARE_KINDS, type ShareKind } from "./share-kinds";
import type { Reach } from "./reach";
import { CATALOGUE_ID } from "./community-site";

export { COMMUNITY_SITE, submitPageUrl } from "./community-site";

export const CATALOGUE_FORMAT = 1;
export const INDEX_FILE = "index.json";
export const INDEX_SIGNATURE_FILE = "index.json.sig";
/**
 * The public keys index.json may be signed with: Ed25519, each its raw 32 bytes in base64 (scripts/sign-catalogue.ts
 * prints a key's). While the list is empty, the index is read without a signature. Once a key is listed, an index
 * whose signature is missing or isn't from a listed key isn't read at all. Two keys at a time during a rotation.
 */
export const CATALOGUE_SIGNING_KEYS: readonly string[] = [];
export const LISTING_FILE = "listing.json";

export const CATALOGUE_LIMITS = {
  /** index.json, as served. */
  indexBytes: 2_000_000,
  /** Items listed in one index. */
  items: 2_000,
  /** Ids taken down, kept in the index so copies that added them can say so. */
  withdrawn: 5_000,
  /** One bundle file, as served (JSON escaping included). */
  bundleBytes: 1_000_000,
  /** Files in one item: a skill's 30 reference files, its SKILL.md and an assistant.json. */
  files: 32,
  /** One file's text, in UTF-8 bytes (lib/skills.ts SKILL_LIMITS.fileBytes). */
  fileBytes: 100_000,
  /** All of an item's files together, in UTF-8 bytes. */
  totalBytes: 500_000,
  name: 64,
  summary: 400,
  reason: 300,
  needs: 10,
  lookups: 10,
  /** A download count above this is refused: no real count is near it. */
  downloads: 1_000_000_000,
} as const;

/** The newest file format of each kind this Athena reads. An item whose `min_format` is higher is hidden. */
export const KIND_FORMATS: Readonly<Record<ShareKind, number>> = {
  assistant: SHARE_FORMAT,
  skill: 1,
  flow: FLOW_SHARE_FORMAT,
  checkin: CHECKIN_SHARE_FORMAT,
  template: TEMPLATE_SHARE_FORMAT,
  theme: THEME_SHARE_FORMAT,
};

/** Can this Athena read an item of this kind and format? Pure. */
export const formatReadable = (kind: ShareKind, minFormat: number): boolean => minFormat <= KIND_FORMATS[kind];

export class CatalogueError extends Error {
  readonly status = 502 as const;
  constructor(message: string) {
    super(message);
    this.name = "CatalogueError";
  }
}

// ---------- pieces ----------

export { CATALOGUE_ID };
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^sha256-[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
/** A file inside an item: up to four segments of letters, digits, `.`, `_` and `-`, none starting with a dot. */
const FILE_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\/){0,3}[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** A bundle's place in the catalogue, relative to its root: "bundles/<id>.json". */
const BUNDLE_PATH = /^(?:[a-z0-9_][a-z0-9._-]{0,63}\/){0,3}[a-z0-9_][a-z0-9._-]{0,63}\.json$/;

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

/** A new catalogue id, for the catalogue's build when it first accepts an item. */
export function mintCatalogueId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  return [...bytes].map((b) => ID_ALPHABET[b & 31]).join("");
}

const when = z.string().datetime({ offset: true });
const line = (max: number) => z.string().max(max).refine((s) => s === s.replace(/\s+/g, " ").trim(), "one line, trimmed");

export const reachSchema: z.ZodType<Reach> = z
  .object({
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    model: z.boolean(),
    web: z.boolean(),
    lookups: z.array(z.string().regex(TOOL)).max(CATALOGUE_LIMITS.lookups),
    needs: z.array(z.string().regex(PROVIDER)).max(CATALOGUE_LIMITS.needs),
  });

// ---------- index.json ----------

export interface CatalogueItem {
  /** Minted once (CATALOGUE_ID), kept for good: what a copy that added it remembers. */
  id: string;
  kind: ShareKind;
  /** Its folder's name: "gift-price-watcher". */
  slug: string;
  name: string;
  summary: string;
  /** A GitHub username, or null when the author asked for none. */
  author: string | null;
  /** The author's own version, or null. */
  version: string | null;
  /** What its files reach (lib/reach.ts), worked out by the catalogue's build. Athena works it out again. */
  reach: Reach;
  /** Accounts it needs, by provider: the same as reach.needs, listed for filtering. */
  needs: string[];
  /** bundleHash of its files. */
  hash: string;
  /** The file format an Athena must read to add it (KIND_FORMATS). */
  min_format: number;
  featured: boolean;
  added_at: string;
  /** Where its CatalogueBundle is, relative to the catalogue's root. */
  bundle: string;
  /**
   * How many times it was downloaded, as the Community site counts it. Optional: an index from before the site
   * counted leaves it out, and the screens then say nothing about it.
   */
  downloads?: number;
}

/** An item taken down. Copies that added it say so on its page; it stays theirs. */
export interface WithdrawnItem {
  id: string;
  at: string;
  /** Plain words for the owner: "It stopped working with Gmail's new labels." */
  reason: string;
}

export interface CatalogueIndex {
  format: typeof CATALOGUE_FORMAT;
  generated_at: string;
  items: CatalogueItem[];
  withdrawn: WithdrawnItem[];
}

export const catalogueItemSchema: z.ZodType<CatalogueItem> = z
  .object({
    id: z.string().regex(CATALOGUE_ID),
    kind: z.enum(SHARE_KINDS),
    slug: z.string().max(64).regex(SLUG),
    name: line(CATALOGUE_LIMITS.name).pipe(z.string().min(1)),
    summary: line(CATALOGUE_LIMITS.summary),
    author: z.string().regex(GITHUB_USER).nullable(),
    version: z.string().regex(VERSION).nullable(),
    reach: reachSchema,
    needs: z.array(z.string().regex(PROVIDER)).max(CATALOGUE_LIMITS.needs),
    hash: z.string().regex(HASH),
    min_format: z.number().int().min(1).max(99),
    featured: z.boolean(),
    added_at: when,
    bundle: z.string().max(260).regex(BUNDLE_PATH),
    downloads: z.number().int().min(0).max(CATALOGUE_LIMITS.downloads).optional(),
  });

export const withdrawnSchema: z.ZodType<WithdrawnItem> = z.object({ id: z.string().regex(CATALOGUE_ID), at: when, reason: line(CATALOGUE_LIMITS.reason) });

const unique = <T>(key: (t: T) => string, what: string) => (list: T[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const t of list) {
    const k = key(t);
    if (seen.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} “${k}” is listed twice` });
    seen.add(k);
  }
};

/** An item whose kind is a word this Athena doesn't know: a kind added after it was built. Pure. */
export const isUnknownKind = (raw: unknown): boolean => !!raw && typeof raw === "object" && typeof (raw as { kind?: unknown }).kind === "string" && !(SHARE_KINDS as readonly string[]).includes((raw as { kind: string }).kind);

/** The listed items as served: counted first, then those of a kind this Athena doesn't know left out. */
const knownItems = z
  .array(z.unknown())
  .max(CATALOGUE_LIMITS.items)
  .transform((list) => list.filter((raw) => !isUnknownKind(raw)));

export const catalogueIndexSchema: z.ZodType<CatalogueIndex, z.ZodTypeDef, unknown> = z
  .object({
    format: z.literal(CATALOGUE_FORMAT),
    generated_at: when,
    items: knownItems.pipe(z.array(catalogueItemSchema)).superRefine(unique((i) => i.id, "item")).superRefine(unique((i) => `${i.kind}/${i.slug}`, "slug")),
    withdrawn: z.array(withdrawnSchema).max(CATALOGUE_LIMITS.withdrawn).superRefine(unique((w) => w.id, "withdrawn id")),
  })
  .superRefine((index, ctx) => {
    const gone = new Set(index.withdrawn.map((w) => w.id));
    for (const i of index.items) if (gone.has(i.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `item “${i.id}” is both listed and withdrawn` });
  });

// ---------- a bundle ----------

export interface CatalogueFile {
  /** Relative to the item's folder: "flow.json", "SKILL.md", "references/prices.csv". */
  path: string;
  text: string;
}

export interface CatalogueBundle {
  id: string;
  /** bundleHash(files): checked on every read, and against the index. */
  hash: string;
  kind: ShareKind;
  files: CatalogueFile[];
}

const fileSchema = z
  .object({
    path: z.string().max(260).regex(FILE_PATH),
    text: z.string().max(CATALOGUE_LIMITS.fileBytes).refine((t) => byteLength(t) <= CATALOGUE_LIMITS.fileBytes, `a file is ${CATALOGUE_LIMITS.fileBytes.toLocaleString("en-GB")} bytes at most`),
  });

export const catalogueBundleSchema: z.ZodType<CatalogueBundle> = z
  .object({
    id: z.string().regex(CATALOGUE_ID),
    hash: z.string().regex(HASH),
    kind: z.enum(SHARE_KINDS),
    files: z.array(fileSchema).min(1).max(CATALOGUE_LIMITS.files).superRefine(unique((f) => f.path, "file")),
  })
  .superRefine((b, ctx) => {
    const total = b.files.reduce((n, f) => n + byteLength(f.text), 0);
    if (total > CATALOGUE_LIMITS.totalBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `an item's files are ${CATALOGUE_LIMITS.totalBytes.toLocaleString("en-GB")} bytes at most` });
    if (!b.files.some((f) => f.path === KIND_FILES[b.kind])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${b.kind} needs ${KIND_FILES[b.kind]} at its top` });
    else if (detectKind(b.files.map((f) => f.path)) !== b.kind) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `its files aren't a ${b.kind}` });
  });

// ---------- listing.json ----------

/** The small file beside each item in the catalogue repository, holding the id minted for it. */
export interface Listing {
  format: typeof CATALOGUE_FORMAT;
  id: string;
  added_at: string;
  featured: boolean;
}

export const listingSchema: z.ZodType<Listing> = z
  .object({ format: z.literal(CATALOGUE_FORMAT), id: z.string().regex(CATALOGUE_ID), added_at: when, featured: z.boolean() });

// ---------- reading them ----------

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string, maxBytes: number, file: string): T {
  if (text.length > maxBytes || byteLength(text) > maxBytes) throw new CatalogueError(`${file} is over ${maxBytes.toLocaleString("en-GB")} bytes.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogueError(`${file} isn't valid JSON.`);
  }
  return check(schema, raw, file);
}

function check<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, file: string): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new CatalogueError(`${file}: ${issue.path.join(".") || "the file"}: ${issue.message}`);
}

/** index.json as served, read and checked. Throws CatalogueError. Pure. */
export const parseCatalogueIndex = (text: string): CatalogueIndex => parse(catalogueIndexSchema, text, CATALOGUE_LIMITS.indexBytes, INDEX_FILE);
/** A bundle as served, read and checked. The hash is checked apart (verifyBundle). Throws CatalogueError. Pure. */
export const parseCatalogueBundle = (text: string): CatalogueBundle => parse(catalogueBundleSchema, text, CATALOGUE_LIMITS.bundleBytes, "The item's bundle");
/** listing.json, read and checked. Throws CatalogueError. Pure. */
export const parseListing = (text: string): Listing => parse(listingSchema, text, 1_000, LISTING_FILE);

// ---------- the hash ----------

/**
 * The hash both repositories compute over an item's files. The canonical encoding, as bytes:
 *
 *   "athena-bundle/1\n"
 *   then, for each file in order of its path's UTF-8 bytes (plain byte order, shorter first when one is a prefix):
 *     the path in UTF-8, "\n",
 *     the text's length in UTF-8 bytes as decimal ASCII digits, "\n",
 *     the text in UTF-8, "\n"
 *
 * The text is hashed exactly as the bundle holds it: no line-ending, trailing-space or Unicode normalisation.
 * The result is "sha256-" and the SHA-256 digest as 64 lowercase hex digits. Two files with one path throw.
 * lib/catalogue-types.test.ts pins it with test vectors; the catalogue's build must give the same.
 */
export async function bundleHash(files: ReadonlyArray<CatalogueFile>): Promise<string> {
  const encoded = files.map((f) => ({ path: utf8.encode(f.path), text: utf8.encode(f.text) }));
  encoded.sort((a, b) => compareBytes(a.path, b.path));
  for (let i = 1; i < encoded.length; i++) if (compareBytes(encoded[i - 1].path, encoded[i].path) === 0) throw new CatalogueError(`Two files share the path “${new TextDecoder().decode(encoded[i].path)}”.`);
  const parts: Uint8Array[] = [utf8.encode("athena-bundle/1\n")];
  const nl = utf8.encode("\n");
  for (const f of encoded) parts.push(f.path, nl, utf8.encode(String(f.text.length)), nl, f.text, nl);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return `sha256-${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Does a bundle's hash match its files, and the index's word for it when given? Pure. */
export async function verifyBundle(bundle: CatalogueBundle, item?: Pick<CatalogueItem, "id" | "hash" | "kind">): Promise<boolean> {
  if (item && (item.id !== bundle.id || item.hash !== bundle.hash || item.kind !== bundle.kind)) return false;
  try {
    return (await bundleHash(bundle.files)) === bundle.hash;
  } catch {
    return false;
  }
}
