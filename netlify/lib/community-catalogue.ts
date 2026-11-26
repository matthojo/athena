/**
 * Community: reading the catalogue. Only Athena's server contacts it, only at `catalogueUrl()`, and only while the
 * owner's "Check the Community catalogue" switch is on (lib/community-config.ts). Every request is a plain GET
 * through `publicFetch` (https only, every address checked as it connects): no site address, account, key or
 * cookie goes with it, and a redirect is followed only while it stays under the catalogue's root.
 *
 * - Once CATALOGUE_SIGNING_KEYS lists a key, index.json is read only with a valid signature from one of them
 *   (index.json.sig, lib/catalogue-signature.ts), checked over the exact bytes sent; a copy kept before a key was
 *   listed isn't used. While the list is empty, the index is read unsigned.
 * - The index (index.json) is kept for a day in the `community` blob store, with the root it came from and the kinds
 *   the Athena that read it knew (`kinds`, from lib/share-kinds.ts). Items of a kind an Athena doesn't know are left
 *   out as it reads, so a copy made before this Athena learnt a kind is missing that kind's items: such a copy, or one
 *   with no `kinds`, is read again whatever its age. When a fresh copy can't be read, the last one is used and the
 *   reason is passed on in words.
 * - The owner can ask for a fresh list ("Check for new items", `checkIndex`): the index is read again only when the
 *   copy is over RECHECK_MS old, and after a failed read not again for RETRY_MS, so the button can't hammer the
 *   catalogue. Formats need no such stamp: every item is kept whatever its `min_format`, and `readableItems` filters
 *   by this Athena's formats each time the list is shown.
 * - A bundle is fetched when an item is opened, checked against its schema, then against its hash and the index's
 *   word for it (`verifyBundle`). A bundle that doesn't match is never used.
 * - A listed theme's colours, for its row in the list: its bundle fetched and checked like any other, read by
 *   readTheme(), and a few colours kept in the `community` store under the bundle's hash, so each version of a theme's
 *   files is read once (`themeSwatchesFor`).
 * - Updates and withdrawals are worked out from the index as it is, against what was added here (pure:
 *   `compareInstalled`, `toPause`). A withdrawn item is paused once; if the owner switches it back on, it stays on.
 */
import { getStore } from "@netlify/blobs";
import { publicFetch } from "./connectors/icons";
import { catalogueFileUrl, catalogueUrl, loadCommunityCheck } from "../../lib/community-config";
import {
  CATALOGUE_ID,
  CATALOGUE_LIMITS,
  CATALOGUE_SIGNING_KEYS,
  CatalogueError,
  INDEX_FILE,
  INDEX_SIGNATURE_FILE,
  formatReadable,
  parseCatalogueBundle,
  parseCatalogueIndex,
  verifyBundle,
  type CatalogueBundle,
  type CatalogueIndex,
  type CatalogueItem,
} from "../../lib/catalogue-types";
import { isLookupTool, tierOf, type Reach } from "../../lib/reach";
import { FLOW_DRAFT_TOOLS } from "../../lib/flow-share";
import { isShareKind, SHARE_KINDS, type ShareKind } from "../../lib/share-kinds";
import type { UpdateCheck } from "../../lib/community-api";
import type { FlowStep } from "../../lib/flow-types";
import { readSharedTheme, themeSwatches, THEME_FILE, type ThemeSwatches } from "../../lib/theme-share";
import { verifyIndexSignature } from "../../lib/catalogue-signature";

/** How long a copy of the index is used before it's read again. */
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * When an item isn't in a cached index, or its bundle doesn't match it, or the owner asks for a fresh list, the index
 * is read again if it's older than this.
 */
export const RECHECK_MS = 10 * 60 * 1000;
/** After a read the owner asked for failed, how long before another one goes out. */
export const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 3;
/** index.json.sig is 88 characters of base64, give or take a line ending. */
const MAX_SIGNATURE_BYTES = 1024;

/** The words the owner reads. */
export const CATALOGUE_WORDS = {
  unreachable: "Athena couldn't reach the Community catalogue.",
  slow: "The Community catalogue took too long to answer.",
  refused: "The Community catalogue didn't send its list.",
  unreadable: "The Community catalogue sent a list Athena couldn't read.",
  unsigned: "The Community catalogue's list wasn't signed, so Athena didn't read it.",
  badSignature: "The Community catalogue's list didn't match its signature, so Athena didn't read it.",
  off: "Checking the Community catalogue is switched off.",
  notSetUp: "Community isn't set up on this Athena.",
  notListed: "That isn't in the Community catalogue.",
  newer: "That needs a newer version of Athena.",
  mismatch: "That item's files didn't match the catalogue, so Athena didn't use them.",
  bundleMissing: "The Community catalogue didn't send that item.",
} as const;

/** A copy of the index as kept. */
export interface CachedIndex {
  root: string;
  fetched_at: string;
  index: CatalogueIndex;
  /**
   * The kinds the Athena that read it knew (SHARE_KINDS then). Missing on copies kept before it was stamped: those
   * count as stale.
   */
  kinds?: string[];
  /** Its signature was checked against a listed key. A copy without it isn't used once a key is listed. */
  signed?: boolean;
  /** When a read the owner asked for last failed, and why, so the next one waits RETRY_MS. */
  failed_at?: string;
  failed?: string;
}

/** A copy made by an Athena that knew every kind this one knows. Pure. */
export const knowsAllKinds = (c: Pick<CachedIndex, "kinds">): boolean => Array.isArray(c.kinds) && SHARE_KINDS.every((k) => c.kinds!.includes(k));

/** A kept copy's index with only the kinds this Athena knows: a copy from a newer Athena may hold more. Pure. */
const knownOnly = (index: CatalogueIndex): CatalogueIndex => (index.items.every((i) => isShareKind(i.kind)) ? index : { ...index, items: index.items.filter((i) => isShareKind(i.kind)) });

export interface IndexCache {
  get(): Promise<CachedIndex | null>;
  set(c: CachedIndex): Promise<void>;
}

const STORE = "community";
const INDEX_KEY = "index";

/** The blob store's copy. A read that fails counts as no copy. */
export const blobIndexCache: IndexCache = {
  async get() {
    try {
      const raw = (await getStore({ name: STORE, consistency: "strong" }).get(INDEX_KEY, { type: "json" })) as CachedIndex | null;
      return raw && typeof raw === "object" && raw.index && typeof raw.fetched_at === "string" ? raw : null;
    } catch {
      return null;
    }
  },
  async set(c) {
    try {
      await getStore({ name: STORE, consistency: "strong" }).setJSON(INDEX_KEY, c);
    } catch (e) {
      console.error("Athena community: keeping the index failed", e);
    }
  },
};

/** A theme's colours for its row, kept by its files' hash: what a hash names never changes. */
export interface SwatchCache {
  get(hash: string): Promise<ThemeSwatches | null>;
  set(hash: string, s: ThemeSwatches): Promise<void>;
}

const swatchKey = (hash: string) => `swatches/${hash.replace(/^sha256-/, "")}`;

export const blobSwatchCache: SwatchCache = {
  async get(hash) {
    try {
      const raw = (await getStore({ name: STORE, consistency: "strong" }).get(swatchKey(hash), { type: "json" })) as ThemeSwatches | null;
      return raw && typeof raw === "object" ? raw : null;
    } catch {
      return null;
    }
  },
  async set(hash, s) {
    try {
      await getStore({ name: STORE, consistency: "strong" }).setJSON(swatchKey(hash), s);
    } catch (e) {
      console.error("Athena community: keeping a theme's colours failed", e);
    }
  },
};

const localRoot = (root: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(root);

/** Replaceable in tests. Production always goes through publicFetch; plain fetch only for a localhost catalogue under `netlify dev`. */
export const catalogueDeps = {
  fetch: (url: string, init: RequestInit): Promise<Response> => (localRoot(url) && process.env.NETLIFY_DEV === "true" ? fetch(url, init) : publicFetch(url, init)),
  root: (): string => catalogueUrl(),
  on: (): Promise<boolean> => loadCommunityCheck(),
  cache: blobIndexCache as IndexCache,
  swatches: blobSwatchCache as SwatchCache,
  now: (): Date => new Date(),
  signingKeys: (): readonly string[] => CATALOGUE_SIGNING_KEYS,
};

/** Thrown with words for the owner: the catalogue couldn't be read. */
export class CatalogueUnreachable extends CatalogueError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueUnreachable";
  }
}

/** One GET under the root: no credentials, same-root redirects only, a deadline and a byte cap. */
async function getText(root: string, path: string, maxBytes: number): Promise<{ status: number; text: string; bytes: Uint8Array }> {
  const first = catalogueFileUrl(root, path);
  if (!first) throw new CatalogueError(CATALOGUE_WORDS.notListed);
  let url: string = first;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res: Response;
    try {
      res = await catalogueDeps.fetch(url, { method: "GET", redirect: "manual", credentials: "omit", signal, headers: { Accept: "application/json" } });
    } catch {
      throw new CatalogueUnreachable(signal.aborted ? CATALOGUE_WORDS.slow : CATALOGUE_WORDS.unreachable);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      const to: string = next ? new URL(next, url).href : "";
      // Only within the catalogue: a hop elsewhere isn't followed.
      if (!to.startsWith(`${root}/`)) throw new CatalogueUnreachable(CATALOGUE_WORDS.refused);
      url = to;
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, text: "", bytes: new Uint8Array(0) };
    }
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new CatalogueError(`${path} is over ${maxBytes.toLocaleString("en-GB")} bytes.`);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        throw new CatalogueUnreachable(signal.aborted ? CATALOGUE_WORDS.slow : CATALOGUE_WORDS.unreachable);
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CatalogueError(`${path} is over ${maxBytes.toLocaleString("en-GB")} bytes.`);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { status: res.status, text: new TextDecoder().decode(bytes), bytes };
  }
  throw new CatalogueUnreachable(CATALOGUE_WORDS.refused);
}

async function fetchIndex(root: string): Promise<{ index: CatalogueIndex; signed: boolean }> {
  const got = await getText(root, INDEX_FILE, CATALOGUE_LIMITS.indexBytes);
  if (got.status !== 200) throw new CatalogueUnreachable(CATALOGUE_WORDS.refused);
  const keys = catalogueDeps.signingKeys();
  if (keys.length) {
    const sig = await getText(root, INDEX_SIGNATURE_FILE, MAX_SIGNATURE_BYTES);
    if (sig.status !== 200) throw new CatalogueUnreachable(CATALOGUE_WORDS.unsigned);
    if (!verifyIndexSignature(got.bytes, sig.text, keys)) {
      console.error("Athena community: index signature refused");
      throw new CatalogueUnreachable(CATALOGUE_WORDS.badSignature);
    }
  }
  try {
    return { index: parseCatalogueIndex(got.text), signed: keys.length > 0 };
  } catch (e) {
    console.error("Athena community: index refused", e instanceof Error ? e.message : e);
    throw new CatalogueUnreachable(CATALOGUE_WORDS.unreadable);
  }
}

export interface IndexRead {
  index: CatalogueIndex;
  fetched_at: string;
  /** Read from the copy kept, not just now. */
  cached: boolean;
  /** Set when a fresh copy couldn't be read and an older one is used. */
  error: string | null;
}

/** The copy kept for this root, or null. Once a key is listed, only a copy whose signature was checked. */
async function keptFor(root: string): Promise<CachedIndex | null> {
  const kept = await catalogueDeps.cache.get();
  if (!kept || kept.root !== root) return null;
  return catalogueDeps.signingKeys().length && kept.signed !== true ? null : kept;
}

async function readAndKeep(root: string, now: Date): Promise<IndexRead> {
  const { index, signed } = await fetchIndex(root);
  const fetched_at = now.toISOString();
  await catalogueDeps.cache.set({ root, fetched_at, index, kinds: [...SHARE_KINDS], ...(signed ? { signed } : {}) });
  return { index, fetched_at, cached: false, error: null };
}

const ageOf = (iso: string | undefined, now: Date) => (iso ? now.getTime() - Date.parse(iso) : Infinity);
const under = (age: number, ms: number) => age >= 0 && age < ms;

/**
 * The index: the copy kept while it's under a day old (or `maxAgeMs`) and was made by an Athena that knew every kind
 * this one does, otherwise read again. Doesn't check the owner's switch: callers do. Throws CatalogueUnreachable when
 * there's no copy at all and none could be read.
 */
export async function getIndex(opts: { maxAgeMs?: number } = {}): Promise<IndexRead> {
  const root = catalogueDeps.root();
  if (!root) throw new CatalogueError(CATALOGUE_WORDS.notSetUp);
  const now = catalogueDeps.now();
  const usable = await keptFor(root);
  if (usable && knowsAllKinds(usable) && under(ageOf(usable.fetched_at, now), opts.maxAgeMs ?? INDEX_TTL_MS)) return { index: knownOnly(usable.index), fetched_at: usable.fetched_at, cached: true, error: null };
  try {
    return await readAndKeep(root, now);
  } catch (e) {
    if (!usable) throw e;
    return { index: knownOnly(usable.index), fetched_at: usable.fetched_at, cached: true, error: e instanceof Error ? e.message : CATALOGUE_WORDS.unreachable };
  }
}

/**
 * "Check for new items": the index read again if the copy kept is over RECHECK_MS old (or was made by an Athena that
 * knew fewer kinds), otherwise the copy. After a failed read, the copy and that failure's words are given until
 * RETRY_MS has passed. Doesn't check the owner's switch: callers do. Throws like getIndex when there's no copy and
 * none could be read.
 */
export async function checkIndex(): Promise<IndexRead> {
  const root = catalogueDeps.root();
  if (!root) throw new CatalogueError(CATALOGUE_WORDS.notSetUp);
  const now = catalogueDeps.now();
  const usable = await keptFor(root);
  if (usable) {
    const copy = { index: knownOnly(usable.index), fetched_at: usable.fetched_at, cached: true };
    if (knowsAllKinds(usable) && under(ageOf(usable.fetched_at, now), RECHECK_MS)) return { ...copy, error: null };
    if (under(ageOf(usable.failed_at, now), RETRY_MS)) return { ...copy, error: usable.failed ?? CATALOGUE_WORDS.unreachable };
  }
  try {
    return await readAndKeep(root, now);
  } catch (e) {
    if (!usable) throw e;
    const error = e instanceof Error ? e.message : CATALOGUE_WORDS.unreachable;
    await catalogueDeps.cache.set({ ...usable, failed_at: now.toISOString(), failed: error });
    return { index: knownOnly(usable.index), fetched_at: usable.fetched_at, cached: true, error };
  }
}

/** What this Athena can show: readable formats, newest first. Pure. */
export function readableItems(index: CatalogueIndex): CatalogueItem[] {
  return index.items.filter((i) => formatReadable(i.kind, i.min_format)).sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at) || a.name.localeCompare(b.name));
}

async function fetchBundle(root: string, item: CatalogueItem): Promise<CatalogueBundle> {
  const got = await getText(root, item.bundle, CATALOGUE_LIMITS.bundleBytes);
  if (got.status !== 200) throw new CatalogueError(CATALOGUE_WORDS.bundleMissing);
  try {
    return parseCatalogueBundle(got.text);
  } catch (e) {
    console.error("Athena community: bundle refused", item.id, e instanceof Error ? e.message : e);
    throw new CatalogueError(CATALOGUE_WORDS.mismatch);
  }
}

/**
 * One catalogue item and its files, checked: the bundle's own hash, and the index's id, kind and hash for it. Used
 * by the `#/add` preview. Fetches nothing while Community isn't set up or the owner's switch is off. Throws
 * CatalogueError with words for the owner.
 */
export async function loadBundle(id: string): Promise<{ item: CatalogueItem; bundle: CatalogueBundle }> {
  if (typeof id !== "string" || !CATALOGUE_ID.test(id)) throw new CatalogueError(CATALOGUE_WORDS.notListed);
  const root = catalogueDeps.root();
  if (!root) throw new CatalogueError(CATALOGUE_WORDS.notSetUp);
  if (!(await catalogueDeps.on())) throw new CatalogueError(CATALOGUE_WORDS.off);
  let read = await getIndex();
  const recent = () => catalogueDeps.now().getTime() - Date.parse(read.fetched_at) < RECHECK_MS;
  const find = () => read.index.items.find((i) => i.id === id) ?? null;
  let item = find();
  // Not in a copy kept a while: it may be newer than that copy.
  if (!item && read.cached && !recent()) {
    read = await getIndex({ maxAgeMs: RECHECK_MS });
    item = find();
  }
  const gone = read.index.withdrawn.find((w) => w.id === id);
  if (gone) throw new CatalogueError(`That was taken down from Community. ${gone.reason}`);
  if (!item) throw new CatalogueError(CATALOGUE_WORDS.notListed);
  if (!formatReadable(item.kind, item.min_format)) throw new CatalogueError(CATALOGUE_WORDS.newer);
  let bundle = await fetchBundle(root, item);
  if (await verifyBundle(bundle, item)) return { item, bundle };
  // The item may have changed since the copy kept: read the index again once, then the bundle.
  if (read.cached && !recent()) {
    read = await getIndex({ maxAgeMs: RECHECK_MS });
    const again = find();
    if (again) {
      bundle = await fetchBundle(root, again);
      if (await verifyBundle(bundle, again)) return { item: again, bundle };
    }
  }
  throw new CatalogueError(CATALOGUE_WORDS.mismatch);
}

/** The most themes whose colours one list reads, four at a time. Past it, a row shows its icon alone. */
const SWATCH_ITEMS = 60;

/**
 * A few colours of each listed theme, by listing id: from the cache by hash, else its bundle fetched and checked
 * (verifyBundle) and read by readTheme(). A theme whose files can't be read is left out. Never throws.
 */
export async function themeSwatchesFor(items: readonly CatalogueItem[]): Promise<Record<string, ThemeSwatches>> {
  const root = catalogueDeps.root();
  const out: Record<string, ThemeSwatches> = {};
  if (!root) return out;
  const themes = items.filter((i) => i.kind === "theme").slice(0, SWATCH_ITEMS);
  const one = async (item: CatalogueItem) => {
    try {
      const kept = await catalogueDeps.swatches.get(item.hash);
      if (kept) return void (out[item.id] = kept);
      const bundle = await fetchBundle(root, item);
      if (!(await verifyBundle(bundle, item))) return;
      const file = bundle.files.find((f) => f.path === THEME_FILE);
      if (!file) return;
      const s = themeSwatches(readSharedTheme(JSON.parse(file.text)).theme);
      out[item.id] = s;
      await catalogueDeps.swatches.set(item.hash, s);
    } catch {
      // Its row shows its icon alone.
    }
  };
  for (let i = 0; i < themes.length; i += 4) await Promise.all(themes.slice(i, i + 4).map(one));
  return out;
}

// ---------- what was added here, against the index ----------

/** One assistant, skill or flow added from the catalogue. */
export interface InstalledItem {
  kind: ShareKind;
  id: string;
  catalogue_id: string;
  catalogue_hash: string;
  catalogue_version: string | null;
  /** Running: an assistant or flow not paused, a skill switched on. */
  on: boolean;
}

/** Updates and withdrawals for what was added here. Only items with something to say are returned. Pure. */
export function compareInstalled(rows: readonly InstalledItem[], index: CatalogueIndex): UpdateCheck[] {
  const items = new Map(index.items.map((i) => [i.id, i]));
  const gone = new Map(index.withdrawn.map((w) => [w.id, w]));
  const out: UpdateCheck[] = [];
  for (const r of rows) {
    const listed = items.get(r.catalogue_id);
    const w = gone.get(r.catalogue_id);
    const newer = listed && listed.hash !== r.catalogue_hash && listed.kind === r.kind && formatReadable(listed.kind, listed.min_format) ? { version: listed.version, hash: listed.hash, summary: listed.summary, reach: listed.reach } : null;
    const withdrawn = w ? { at: w.at, reason: w.reason } : null;
    if (!newer && !withdrawn) continue;
    out.push({ kind: r.kind, id: r.id, catalogue_id: r.catalogue_id, version: r.catalogue_version, hash: r.catalogue_hash, newer, withdrawn });
  }
  return out;
}

/** The key that remembers an item was paused for a withdrawal, so it's paused once. */
export const pauseKey = (r: Pick<InstalledItem, "kind" | "id" | "catalogue_id">): string => `${r.kind}:${r.id}:${r.catalogue_id}`;

/** Items to pause now: withdrawn, running, and not paused for this before. Pure. */
export function toPause(rows: readonly InstalledItem[], index: CatalogueIndex, pausedBefore: ReadonlySet<string>): InstalledItem[] {
  const gone = new Set(index.withdrawn.map((w) => w.id));
  return rows.filter((r) => gone.has(r.catalogue_id) && r.on && !pausedBefore.has(pauseKey(r)));
}

/** A flow's tier as it is here, from its steps: for "the reach changed" on an update. Pure. */
export function flowTier(steps: readonly FlowStep[]): Reach["tier"] {
  let model = false;
  let web = false;
  const lookups: string[] = [];
  const walk = (list: readonly FlowStep[]) => {
    for (const s of list) {
      if (s.kind === "think") {
        model = true;
        if (s.web) web = true;
      } else if (s.kind === "assignment") model = true;
      else if (s.kind === "tool") {
        if (FLOW_DRAFT_TOOLS.includes(s.tool)) model = true;
        if (isLookupTool(s.tool)) lookups.push(s.tool);
      } else if (s.kind === "check") {
        walk(s.yes);
        walk(s.no);
      } else if (s.kind === "ask") for (const c of s.choices) walk(c.steps);
    }
  };
  walk(steps);
  return tierOf({ model, web, lookups });
}
