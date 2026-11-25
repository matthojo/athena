/**
 * Sets of check-in questions on the server (lib/checkin-share.ts has the format and the pure parts): sharing some of
 * the owner's questions as a file, adding a set someone shared, switching a set off and on, and removing one.
 *
 * - `exportCheckinsFor`: POST /api/checkins/share. The questions the owner picked (their own, written here) as a file,
 *   with links into their Athena taken out and the personal-data check run against their people, places and the rest
 *   (lib/team-share-store.ts knownTerms), as for an assistant or a flow. Nothing is kept.
 * - `addSharedCheckins`: what the `#/add` screen's Add does for check-in questions. The file is read again, never
 *   trusted. A `checkin_sets` row (migration 0090) records the set; each question whose words the owner doesn't
 *   already have joins their own questions and the end of its routines (joinSharedCheckins). No routine is switched on.
 * - `replaceSharedCheckins`: Update, from a newer Community listing: the set's questions are taken out and the new
 *   version's joined in their place, at the end. The set keeps its row and whether it's switched off.
 * - `setCheckinSetPaused`, `removeCheckinSet`: Settings' switch and Remove. Community's withdrawal check switches a
 *   set off the same way (netlify/lib/community-routes.ts).
 */
import { AthenaInputError, qRaw } from "./db";
import { checkSettings, listSets, loadCheckinSettings, saveCheckinSettings, settingsView } from "./checkins";
import { knownTerms } from "./team-share-store";
import { writeSkillZip } from "./skill-zip";
import { CHECKIN_FILE, exportCheckins, joinSharedCheckins, offersDeeper, readSharedCheckins, removeSetFrom, serialiseSharedCheckins, setQuestions, type CheckinExport, type SharedCheckins } from "./checkin-share";
import { ShareFormatError, type KnownTerm } from "./team-share";
import type { CheckinKind, CheckinSettings, CheckinSettingsView } from "./checkin-types";
import type { Reach } from "./reach";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOGUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** A new id for one of the owner's own questions, as the app makes them. */
const ownId = () => `own_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

function readSetId(id: string): string {
  if (!UUID.test(id)) throw new AthenaInputError("There's no such set of questions", 404);
  return id.toLowerCase();
}

async function saveSettings(s: CheckinSettings): Promise<CheckinSettingsView> {
  return saveCheckinSettings({ morning: s.morning, evening: s.evening, own: s.own });
}

// ---------- sharing ----------

/**
 * Some of the owner's questions as a file to share. `raw` is the request: `{ question_ids, edits?, fine? }`. Only
 * questions they wrote here can go: Athena's own and those added from someone else's set are refused. Throws
 * AthenaInputError with words.
 */
export async function exportCheckinsFor(raw: Record<string, unknown>, opts: { hosts: string[]; known?: KnownTerm[]; settings?: CheckinSettings }): Promise<CheckinExport> {
  const ids = Array.isArray(raw.question_ids) ? raw.question_ids.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
  const settings = opts.settings ?? (await loadCheckinSettings());
  const picked = [...new Set(ids)].map((id) => {
    const q = settings.own.find((x) => x.id === id);
    if (!q) throw new AthenaInputError("Only questions you wrote can be shared. One of those isn't there any more.");
    if (q.set) throw new AthenaInputError(`“${q.prompt}” came from a set someone else shared. Share only questions you wrote.`);
    return q;
  });
  const e = (raw.edits && typeof raw.edits === "object" ? raw.edits : {}) as Record<string, unknown>;
  const fine = Array.isArray(raw.fine) ? raw.fine.filter((f): f is string => typeof f === "string").slice(0, 200) : [];
  try {
    return exportCheckins(picked, {
      ownHosts: opts.hosts,
      known: opts.known ?? (await knownTerms()),
      edits: { name: str(e.name, 200), summary: str(e.summary, 800), version: str(e.version, 20), author: str(e.author, 40) },
      fine,
    });
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

/** The download: <slug>/checkin.json in a zip. */
export function checkinZip(x: CheckinExport): Uint8Array {
  return writeSkillZip([{ path: `${x.slug}/${CHECKIN_FILE}`, text: serialiseSharedCheckins(x.shared) }]);
}

// ---------- adding ----------

export interface AddedCheckins {
  id: string;
  added: number;
  skipped: string[];
  off: CheckinKind[];
  /** Left out: the owner's own questions reached the limit. */
  full: string[];
}

function readListing(catalogue?: { id: string; hash: string; version?: string }) {
  if (!catalogue) return null;
  if (!CATALOGUE_ID.test(catalogue.id) || !HASH.test(catalogue.hash)) throw new AthenaInputError("That catalogue listing isn't one Athena can read.");
  const version = typeof catalogue.version === "string" ? catalogue.version.trim().slice(0, 20) : "";
  return { id: catalogue.id, hash: catalogue.hash, version: version || null };
}

function readShared(shared: SharedCheckins): SharedCheckins {
  try {
    return readSharedCheckins(shared);
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

/**
 * Add a shared set: read again, recorded as a set, its new questions joined to the owner's own and to the end of
 * their routines. A routine that's off stays off. `opts.start` false adds the set switched off (the Add screen's
 * "When to start": "Add them switched off"; asking them is the default). Throws AthenaInputError with words (a bad file).
 */
export async function addSharedCheckins(raw: SharedCheckins, catalogue?: { id: string; hash: string; version?: string }, opts: { start?: boolean } = {}): Promise<AddedCheckins> {
  const shared = readShared(raw);
  const listing = readListing(catalogue);
  const id = crypto.randomUUID();
  let joined;
  try {
    joined = joinSharedCheckins(await loadCheckinSettings(), shared, { setId: id, newId: ownId });
    checkSettings(joined.settings);
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  await qRaw(
    `INSERT INTO checkin_sets (id, name, summary, author, version, catalogue_id, catalogue_hash, catalogue_version, paused) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, shared.name, shared.summary, shared.author ?? null, shared.version ?? null, listing?.id ?? null, listing?.hash ?? null, listing?.version ?? null, opts.start === false],
  );
  try {
    await saveSettings(joined.settings);
  } catch (error) {
    await qRaw(`DELETE FROM checkin_sets WHERE id = $1::uuid`, [id]).catch(() => undefined);
    throw error;
  }
  return { id, added: joined.added.length, skipped: joined.skipped, off: joined.off, full: joined.full };
}

/**
 * Update a set added from Community to a newer version: its questions out, the new version's in, at the end of each
 * routine. Its row stays, and so does whether it's switched off. Throws AthenaInputError with words.
 */
export async function replaceSharedCheckins(setId: string, raw: SharedCheckins, catalogue: { id: string; hash: string; version?: string }): Promise<AddedCheckins> {
  const id = readSetId(setId);
  const shared = readShared(raw);
  const listing = readListing(catalogue)!;
  const [row] = await qRaw<{ id: string }>(`SELECT id::text AS id FROM checkin_sets WHERE id = $1::uuid`, [id]);
  if (!row) throw new AthenaInputError("That set of questions isn't there any more", 404);
  let joined;
  try {
    joined = joinSharedCheckins(removeSetFrom(await loadCheckinSettings(), id), shared, { setId: id, newId: ownId });
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  await saveSettings(joined.settings);
  await qRaw(
    `UPDATE checkin_sets SET name = $2, summary = $3, author = $4, version = $5, catalogue_id = $6, catalogue_hash = $7, catalogue_version = $8, updated_at = now() WHERE id = $1::uuid`,
    [id, shared.name, shared.summary, shared.author ?? null, shared.version ?? null, listing.id, listing.hash, listing.version],
  );
  return { id, added: joined.added.length, skipped: joined.skipped, off: joined.off, full: joined.full };
}

// ---------- switching off, removing ----------

/** Settings' switch for a set: off, its questions aren't asked; on again, they take their turns as before. */
export async function setCheckinSetPaused(setId: string, paused: boolean): Promise<CheckinSettingsView> {
  const id = readSetId(setId);
  const rows = await qRaw<{ id: string }>(`UPDATE checkin_sets SET paused = $2, updated_at = now() WHERE id = $1::uuid RETURNING id::text AS id`, [id, paused]);
  if (!rows.length) throw new AthenaInputError("That set of questions isn't there any more", 404);
  return settingsView(await loadCheckinSettings(), await listSets());
}

/** Remove a set: its questions come out of both routines and the owner's own; answers already given stay on their days. */
export async function removeCheckinSet(setId: string): Promise<CheckinSettingsView> {
  const id = readSetId(setId);
  const next = removeSetFrom(await loadCheckinSettings(), id);
  await saveSettings(next);
  await qRaw(`DELETE FROM checkin_sets WHERE id = $1::uuid`, [id]);
  return settingsView(next, await listSets());
}

/** A set's tier as it is here now, for Community's Update banner: 2 when one of its questions offers Go deeper. */
export async function checkinSetTier(setId: string): Promise<Reach["tier"] | null> {
  if (!UUID.test(setId)) return null;
  const [row] = await qRaw<{ id: string }>(`SELECT id::text AS id FROM checkin_sets WHERE id = $1::uuid`, [setId]);
  if (!row) return null;
  return offersDeeper(setQuestions(await loadCheckinSettings(), row.id)) ? 2 : 1;
}
