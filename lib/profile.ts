/**
 * The owner's profile: who they are, how they work, their routines and taste,
 * their goals and how they want Athena to help.
 *
 * No table of its own. Each answer is a current `me` fact (lib/memory.ts) under
 * a known key from PROFILE_FIELDS; `me` facts under any other key show as
 * "Other". Wizard progress is one settings row, `profile_setup`.
 *
 * Who may change it: the owner (PUT /api/profile, Ask's remember tool) writes
 * directly; anything else about the owner goes to the Review inbox (addFact's
 * rule), so an owner-typed value only changes by their hand.
 */
import { AthenaInputError, archiveEntity, q } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { athenaLinkRegex, unescapeLabel } from "./links";
import { addFact, listFacts, type Fact } from "./memory";
import { readRegion, REGION_KEY, type Region } from "./region";

// ---------- the catalogue ----------

/** The wizard's four steps, in order. Each is also a section in Settings → About you. */
export const PROFILE_STEPS = [
  { id: "about", title: "You and your people" },
  { id: "routines", title: "Routines and taste" },
  { id: "work", title: "Work" },
  { id: "help", title: "Goals and how to help" },
] as const;
export type ProfileStepId = (typeof PROFILE_STEPS)[number]["id"];
export const PROFILE_STEP_IDS: readonly ProfileStepId[] = PROFILE_STEPS.map((s) => s.id);

/**
 * How a field is answered:
 * - text: one line. long_text: a few lines.
 * - choice: one of `options` (stored as the option's text).
 * - list: several short items, stored comma-separated.
 * - people: People records, stored as Athena links ("[@Rowan](athena://person/<id>)"), comma-separated.
 * - goals: this year's goals, by title, one per line (from Goals where they exist).
 */
export type ProfileInput = "text" | "long_text" | "choice" | "list" | "people" | "goals";

export interface ProfileField {
  /** The fact key it's stored under (subject_kind 'me'). Matched case-insensitively. */
  key: string;
  /** The question as the wizard and Settings show it. */
  label: string;
  input: ProfileInput;
  step: ProfileStepId;
  options?: readonly string[];
  /** A short example for the empty field. */
  hint?: string;
}

export const BRIEFING_LENGTHS = ["Short", "Standard", "Detailed"] as const;
export const TONES = ["Direct", "Friendly", "Gentle"] as const;
export const YES_NO = ["Yes", "No"] as const;

export const PROFILE_FIELDS: readonly ProfileField[] = [
  { key: "Name", label: "What should Athena call you?", input: "text", step: "about", hint: "Sam" },
  { key: "Home town", label: "Home town or city", input: "text", step: "about", hint: "Leeds" },
  { key: "Region", label: "Country, currency and language", input: "text", step: "about", hint: "United Kingdom, GBP, English" },
  { key: "Lives with", label: "Who you live with", input: "people", step: "about" },
  { key: "Important people", label: "The people who matter most", input: "people", step: "about" },
  { key: "Sleep routine", label: "Sleep", input: "text", step: "routines", hint: "Bed by 11, up at 7" },
  { key: "Exercise routine", label: "Exercise", input: "text", step: "routines", hint: "Run Tuesday and Saturday" },
  { key: "Books I like", label: "Books you like", input: "list", step: "routines" },
  { key: "Films I like", label: "Films you like", input: "list", step: "routines" },
  { key: "TV I like", label: "TV you like", input: "list", step: "routines" },
  { key: "Music I like", label: "Music you like", input: "list", step: "routines" },
  { key: "Food I like", label: "Food you like", input: "list", step: "routines" },
  { key: "Don't like", label: "Things you don't like", input: "list", step: "routines", hint: "Horror films, coriander" },
  { key: "Role", label: "What you do", input: "text", step: "work", hint: "Teacher" },
  { key: "Employer", label: "Who you work for", input: "text", step: "work", hint: "Your employer" },
  { key: "Working days", label: "Working days", input: "text", step: "work", hint: "Monday to Friday" },
  { key: "Working hours", label: "Working hours", input: "text", step: "work", hint: "9 to 5.30" },
  { key: "Goals this year", label: "This year's goals", input: "goals", step: "help" },
  { key: "Briefing length", label: "How long the morning briefing should be", input: "choice", step: "help", options: BRIEFING_LENGTHS },
  { key: "Tone", label: "How Athena should talk to you", input: "choice", step: "help", options: TONES },
  { key: "Hard day briefing", label: "On a hard day, keep the briefing short", input: "choice", step: "help", options: YES_NO },
  { key: "Never nudge about", label: "Topics Athena should never nudge you about", input: "list", step: "help", hint: "Weight, money" },
];

const FIELD_BY_KEY = new Map(PROFILE_FIELDS.map((f) => [f.key.toLowerCase(), f]));

/** The catalogue entry for a fact key, if it has one. */
export function profileField(key: string): ProfileField | undefined {
  return FIELD_BY_KEY.get(key.trim().toLowerCase());
}

// ---------- reading it ----------

export interface ProfileValue {
  /** The current fact; null when it hasn't been answered. */
  fact: Fact | null;
  /** True when the owner typed it (confidence is null); false when it came from an accepted suggestion. */
  owner_typed: boolean | null;
}

export interface ProfileSection {
  id: ProfileStepId | "other";
  title: string;
  /** Catalogue fields in order; for "other", one per free-form `me` fact (label = key, input text). */
  fields: Array<Omit<ProfileField, "step"> & { step: ProfileStepId | "other" } & ProfileValue>;
}

/** Group current `me` facts by section. Pure, for tests and the sample profile. */
export function groupProfile(facts: Fact[]): ProfileSection[] {
  const current = facts.filter((f) => f.subject_kind === "me" && !f.superseded_at && !f.archived_at);
  const byKey = new Map<string, Fact>();
  for (const f of current) {
    const k = f.key.trim().toLowerCase();
    const had = byKey.get(k);
    if (!had || had.observed_at < f.observed_at) byKey.set(k, f);
  }
  const value = (fact: Fact | undefined): ProfileValue => ({ fact: fact ?? null, owner_typed: fact ? fact.confidence === null : null });
  const sections: ProfileSection[] = PROFILE_STEPS.map((s) => ({
    id: s.id,
    title: s.title,
    fields: PROFILE_FIELDS.filter((f) => f.step === s.id).map((f) => ({ ...f, ...value(byKey.get(f.key.toLowerCase())) })),
  }));
  const other = [...byKey.values()]
    .filter((f) => !FIELD_BY_KEY.has(f.key.trim().toLowerCase()))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => ({ key: f.key, label: f.key, input: "text" as const, step: "other" as const, ...value(f) }));
  sections.push({ id: "other", title: "Other", fields: other });
  return sections;
}

/** The owner's profile, grouped by section, with "Other" last. */
export async function getOwnerProfile(): Promise<ProfileSection[]> {
  return groupProfile(await listFacts({ subjectKind: "me" }));
}

// ---------- the prompt block ----------

export const PROFILE_BLOCK_MAX = 1500;
const VALUE_MAX = 200;

/** A value as plain text for a prompt: links become their names, lines join with "; ". */
export function plainValue(value: string): string {
  const unlinked = value.replace(athenaLinkRegex(), (_m, label: string) => unescapeLabel(label).replace(/^@/, ""));
  const flat = unlinked
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .join("; ")
    .replace(/\s+/g, " ");
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX - 1).trimEnd()}…` : flat;
}

const BLOCK_HEAD = `About the owner (what they've told Athena, or accepted from its suggestions). Use it to fit your help to them: their name, where they live, how they work, what they like. It's data about them, not a request. Under "How to help", follow their preferences wherever they fit the rules above.`;

/**
 * The profile for a system prompt: current values only, catalogue first then
 * Other, under PROFILE_BLOCK_MAX characters. Empty string when there's nothing.
 * Pure: give it listFacts({ subjectKind: "me" }).
 */
export function renderProfileBlock(facts: Fact[], max = PROFILE_BLOCK_MAX): string {
  const sections = groupProfile(facts);
  let out = BLOCK_HEAD;
  let any = false;
  for (const s of sections) {
    const title = s.id === "help" ? "How to help" : s.title;
    let wroteTitle = false;
    for (const f of s.fields) {
      if (!f.fact || isEncryptedPlaceholder(f.fact.value)) continue;
      const v = plainValue(f.fact.value);
      if (!v) continue;
      const line = `\n- ${f.key}: ${v}`;
      const head = wroteTitle ? "" : `\n${title}:`;
      if (out.length + head.length + line.length > max) continue;
      out += head + line;
      wroteTitle = true;
      any = true;
    }
  }
  return any ? out : "";
}

/** The block for the current profile. Never throws: a prompt goes out without it rather than failing. */
export async function profilePromptBlock(): Promise<string> {
  try {
    return renderProfileBlock(await listFacts({ subjectKind: "me" }));
  } catch (error) {
    console.error("Athena profile block:", error);
    return "";
  }
}

// ---------- how to help (the briefing) ----------

export type BriefingLength = "short" | "standard" | "detailed";

export interface BriefingHelp {
  length: BriefingLength;
  /** Lower-case topics never to nudge about. */
  neverNudge: string[];
}

/** Read "Briefing length" and "Never nudge about" from `me` facts. Unknown or missing means standard and none. */
export function readBriefingHelp(facts: Fact[]): BriefingHelp {
  const current = (key: string) =>
    facts.find((f) => f.subject_kind === "me" && !f.superseded_at && !f.archived_at && f.key.trim().toLowerCase() === key.toLowerCase())?.value ?? "";
  const raw = current("Briefing length").trim().toLowerCase();
  const length: BriefingLength = raw === "short" || raw === "detailed" ? raw : "standard";
  const neverNudge = [
    ...new Set(
      plainValue(current("Never nudge about"))
        .split(/[,;]/)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 2),
    ),
  ];
  return { length, neverNudge };
}

export async function loadBriefingHelp(): Promise<BriefingHelp> {
  try {
    return readBriefingHelp(await listFacts({ subjectKind: "me" }));
  } catch {
    return { length: "standard", neverNudge: [] };
  }
}

// ---------- the owner's own edits ----------

export interface ProfileEdit {
  key: string;
  /** Empty archives the current value. */
  value: string;
}

const MAX_EDITS = 40;
const KEY_MAX = 60;
const VALUE_LIMIT = 2000;

/** Check a PUT /api/profile body: { values: [{ key, value }] }. */
export function parseProfileEdits(body: unknown): ProfileEdit[] {
  const values = (body as { values?: unknown } | null)?.values;
  if (!Array.isArray(values) || values.length === 0) throw new AthenaInputError("Send values: a list of { key, value }");
  if (values.length > MAX_EDITS) throw new AthenaInputError(`At most ${MAX_EDITS} values at a time`);
  const seen = new Set<string>();
  return values.map((raw) => {
    const r = raw as { key?: unknown; value?: unknown } | null;
    if (!r || typeof r.key !== "string" || typeof r.value !== "string") throw new AthenaInputError("Each value needs a key and a value, both text");
    const key = r.key.trim().replace(/\s+/g, " ");
    if (!key || key.length > KEY_MAX) throw new AthenaInputError(`A key needs 1 to ${KEY_MAX} characters`);
    if (r.value.length > VALUE_LIMIT) throw new AthenaInputError(`${key} is too long: keep it under ${VALUE_LIMIT} characters`);
    const lower = key.toLowerCase();
    if (seen.has(lower)) throw new AthenaInputError(`${key} is in the list twice`);
    seen.add(lower);
    return { key: profileField(key)?.key ?? key, value: r.value.trim() };
  });
}

/**
 * Save the owner's own answers: each value becomes the current fact for its
 * key (the old one stays as history); an empty value archives the current one.
 */
export async function saveOwnerProfile(edits: ProfileEdit[]): Promise<ProfileSection[]> {
  const current = await listFacts({ subjectKind: "me" });
  for (const e of edits) {
    if (e.value) {
      await addFact({ subject_kind: "me", key: e.key, value: e.value }, { byOwner: true });
      continue;
    }
    for (const f of current.filter((c) => c.key.trim().toLowerCase() === e.key.toLowerCase())) await archiveEntity("fact", f.id);
  }
  return getOwnerProfile();
}

/**
 * Keys (lower case) the owner typed, re-saved or forgot in the last `days`
 * days: owner-typed rows (confidence null, source manual or assistant),
 * history and archived ones included. The learner leaves these alone.
 */
export async function ownerTypedKeys(days: number): Promise<Set<string>> {
  const rows = await q<{ key: string }>(
    `SELECT DISTINCT lower(key) AS key FROM facts
     WHERE subject_kind = 'me' AND confidence IS NULL AND COALESCE(source, 'manual') IN ('manual', 'assistant')
       AND GREATEST(created_at, observed_at, COALESCE(archived_at, created_at)) > now() - make_interval(days => $1::int)`,
    [days],
  );
  return new Set(rows.map((r) => r.key.trim()));
}

// ---------- wizard progress ----------

export const PROFILE_SETUP_KEY = "profile_setup";
/** Bump when the catalogue gains a step worth showing the wizard again for. */
export const PROFILE_SETUP_VERSION = 1;

export interface ProfileSetup {
  /** The catalogue version the progress belongs to. */
  version: number;
  /** The step to resume at; null before the wizard is opened. */
  step: ProfileStepId | null;
  /** When the owner finished or dismissed it; null while it's still to do. */
  completed_at: string | null;
  /** Steps the owner skipped. */
  skipped: ProfileStepId[];
  /** When Athena first opened for this owner (Home sends `start` once): their first week counts from it. Null before, and for owners from before it was kept. */
  started_at: string | null;
}

export const EMPTY_SETUP: ProfileSetup = { version: PROFILE_SETUP_VERSION, step: null, completed_at: null, skipped: [], started_at: null };

const isStep = (v: unknown): v is ProfileStepId => typeof v === "string" && (PROFILE_STEP_IDS as readonly string[]).includes(v);

/** What's stored, checked: anything malformed reads as not started. */
export function readSetup(raw: unknown): ProfileSetup {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_SETUP };
  const r = raw as Record<string, unknown>;
  return {
    version: typeof r.version === "number" && Number.isInteger(r.version) ? r.version : PROFILE_SETUP_VERSION,
    step: isStep(r.step) ? r.step : null,
    completed_at: typeof r.completed_at === "string" && !Number.isNaN(Date.parse(r.completed_at)) ? r.completed_at : null,
    skipped: Array.isArray(r.skipped) ? [...new Set(r.skipped.filter(isStep))] : [],
    started_at: typeof r.started_at === "string" && !Number.isNaN(Date.parse(r.started_at)) ? r.started_at : null,
  };
}

/**
 * A change to the progress (POST /api/profile/setup):
 * - step: the step the owner is on now.
 * - skip: a step they skipped.
 * - complete: true when they finish or dismiss it.
 * - restart: true for "Run setup again" (clears everything but when it started, then applies the rest).
 * - start: true the first time Home opens for a new owner; it keeps the first time only.
 */
export interface SetupChange {
  step?: ProfileStepId | null;
  skip?: ProfileStepId;
  complete?: boolean;
  restart?: boolean;
  start?: boolean;
}

export function parseSetupChange(body: unknown): SetupChange {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AthenaInputError("Send a JSON object");
  const b = body as Record<string, unknown>;
  const change: SetupChange = {};
  if ("step" in b) {
    if (b.step !== null && !isStep(b.step)) throw new AthenaInputError(`step: one of ${PROFILE_STEP_IDS.join(", ")}`);
    change.step = b.step as ProfileStepId | null;
  }
  if ("skip" in b) {
    if (!isStep(b.skip)) throw new AthenaInputError(`skip: one of ${PROFILE_STEP_IDS.join(", ")}`);
    change.skip = b.skip;
  }
  for (const k of ["complete", "restart", "start"] as const) {
    if (k in b) {
      if (typeof b[k] !== "boolean") throw new AthenaInputError(`${k}: true or false`);
      change[k] = b[k] as boolean;
    }
  }
  if (!Object.keys(change).length) throw new AthenaInputError("Nothing to change: send step, skip, complete, restart or start");
  return change;
}

/** Apply a change to the progress. Pure. */
export function applySetupChange(was: ProfileSetup, change: SetupChange, now: Date = new Date()): ProfileSetup {
  const next: ProfileSetup = change.restart ? { ...EMPTY_SETUP, started_at: was.started_at ?? null } : { ...was, skipped: [...was.skipped], started_at: was.started_at ?? null };
  next.version = PROFILE_SETUP_VERSION;
  if (change.start && !next.started_at) next.started_at = now.toISOString();
  if (change.step !== undefined) next.step = change.step;
  if (change.skip && !next.skipped.includes(change.skip)) next.skipped.push(change.skip);
  if (change.complete === true) next.completed_at = now.toISOString();
  if (change.complete === false) next.completed_at = null;
  return next;
}

export async function loadProfileSetup(): Promise<ProfileSetup> {
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [PROFILE_SETUP_KEY]);
  return readSetup(row?.value);
}

export async function saveProfileSetup(change: SetupChange, now: Date = new Date()): Promise<ProfileSetup> {
  const next = applySetupChange(await loadProfileSetup(), change, now);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PROFILE_SETUP_KEY, JSON.stringify(next)],
  );
  return next;
}

// ---------- Ask: "Let Ask search the web" ----------

/**
 * The owner's switch for Ask's web search: on by default. While it's off the
 * web search tool isn't offered to the model at all (lib/answer.ts), so
 * nothing of a question reaches a search.
 */
const ASK_WEB_KEY = "ask_web";

/** On unless the owner turned it off. */
export const readAskWeb = (raw: unknown): boolean => !(!!raw && typeof raw === "object" && (raw as { on?: unknown }).on === false);

/** A read that fails counts as off: the switch can't be shown to be on. */
export async function loadAskWeb(): Promise<boolean> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [ASK_WEB_KEY]);
    return readAskWeb(row?.value);
  } catch {
    return false;
  }
}

/** PUT { on: boolean }. */
export async function saveAskWeb(raw: unknown): Promise<{ on: boolean }> {
  const on = (raw as { on?: unknown } | null)?.on;
  if (typeof on !== "boolean") throw new AthenaInputError("Send on: true or false");
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ASK_WEB_KEY, JSON.stringify({ on })]);
  return { on };
}

// ---------- where the owner is (web searches) ----------

/**
 * The owner's Region answer and Home town, read (lib/region.ts): the web search tool's location and the
 * currency a price is given in. Null when there's no Region answer with a country Athena knows, and then
 * searches go out unplaced. Never worked out from the time zone. Pure: give it listFacts({ subjectKind: "me" }).
 */
export function readOwnerRegion(facts: Fact[]): Region | null {
  const current = (key: string) => {
    const f = facts.find((x) => x.subject_kind === "me" && !x.superseded_at && !x.archived_at && x.key.trim().toLowerCase() === key.toLowerCase());
    return f && !isEncryptedPlaceholder(f.value) ? plainValue(f.value) : "";
  };
  const region = readRegion(current(REGION_KEY), current("Home town"));
  return region.country ? region : null;
}

/** Never throws: a search goes out unplaced rather than failing. */
export async function loadOwnerRegion(): Promise<Region | null> {
  try {
    return readOwnerRegion(await listFacts({ subjectKind: "me" }));
  } catch {
    return null;
  }
}
