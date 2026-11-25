/**
 * Shared check-in questions: a set of the morning and evening questions as a file someone else can add to their own
 * check-ins. Pure and shared by the server and the app: the format, its limits and the reader, making one from the
 * owner's own questions (`exportCheckins`), and joining one to a set-up (`joinSharedCheckins`, `removeSetFrom`). The
 * server side is lib/checkin-sets.ts; the contract for check-ins is lib/checkin-types.ts.
 *
 * A shared set is a folder, usually on its own:
 *
 *   <slug>/checkin.json   a name, a one-line summary, the optional header every shared file carries (version,
 *                         author, based_on) and the questions
 *
 * Each question carries what the owner's own questions carry and nothing else: its words (`prompt`), the routines
 * it's asked in (`kinds`: morning, evening or both), how it's answered (`type`) and, for that type, the slider's
 * sentence and ends, the choices, or the hint and whether it offers Go deeper. Never an id, an answer, a day, a
 * pin, a count a day, or where answers are copied to (`mirror`): those are the owner's.
 *
 * Where answers go is Athena's to decide, never the file's (owner, 25 Nov 2026): `sharedMirror`. A written answer is
 * copied into that day's journal, as Athena's own written questions' are (`day_journal`, lib/checkin-journal.ts). A
 * scale, choices or areas answer stays in the check-in, since none of Athena's own questions of those types goes to
 * the journal. No shared question ever sets the day's mood, Health's energy, stress or mood words, or the briefing.
 *
 * Reading one (`readSharedCheckins`) treats every word as someone else's, as the other readers do: checked against
 * the check-in limits, unknown keys dropped (and a field that belongs to another type of answer), an unknown type of
 * answer refused with words. Nothing in the file is a permission.
 *
 * Adding a set never replaces or reorders what's there: each question joins the owner's own questions and the end of
 * each routine it's asked in, unpinned. A question whose words the owner already has is skipped. A routine that's off
 * stays off. When the owner's own questions would go past MAX_OWN_QUESTIONS, questions are added in the set's order
 * until there's no room, and the rest are named as left out (owner, 25 Nov 2026).
 */
import { CHECKIN_KINDS, MAX_OWN_QUESTIONS, PRESET_QUESTIONS, type CheckinKind, type CheckinMirror, type CheckinQuestion, type CheckinSettings, type QuestionType } from "./checkin-types";
import { readHeader, type ShareHeader } from "./share-kinds";
import { addRemoved, findPersonal, scrubText, ShareFormatError, type CheckField, type Finding, type KnownTerm, type Removed } from "./team-share";

export const CHECKIN_SHARE_FORMAT = 1;
export const CHECKIN_FILE = "checkin.json";

/** The limits a shared set is read against: the same as the owner's own questions (lib/checkins.ts readOwnQuestion). */
export const CHECKIN_SHARE_LIMITS = {
  /** Questions in one set: as many as the owner can have of their own. */
  questions: MAX_OWN_QUESTIONS,
  name: 64,
  summary: 400,
  prompt: 200,
  /** A scale's two ends, and each of its five steps. */
  end: 40,
  lead: 60,
  /** Choices shown first, and behind "Show more". */
  options: 30,
  option: 40,
  placeholder: 120,
} as const;

export const QUESTION_TYPES: readonly QuestionType[] = ["scale", "choices", "areas", "text"];

/** One question as a file carries it. */
export interface SharedCheckinQuestion {
  prompt: string;
  kinds: CheckinKind[];
  type: QuestionType;
  /** scale */
  lead?: string;
  levels?: [string, string, string, string, string];
  low?: string;
  high?: string;
  /** choices and areas */
  options?: string[];
  more?: string[];
  /** text */
  placeholder?: string;
  deeper?: boolean;
}

export interface SharedCheckins extends ShareHeader {
  format: typeof CHECKIN_SHARE_FORMAT;
  name: string;
  /** One line on what the questions are for, for the preview. */
  summary: string;
  questions: SharedCheckinQuestion[];
}

// ---------- reading one ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const fail = (msg: string): never => {
  throw new ShareFormatError(msg);
};
const TYPE_WORDS: Record<QuestionType, string> = { scale: "a scale", choices: "choices", areas: "life areas", text: "a written answer" };

function words(raw: unknown, at: string, max: number, opts: { required?: boolean } = {}): string {
  if (raw === undefined || raw === null) return opts.required ? fail(`${at}: missing`) : "";
  if (typeof raw !== "string") return fail(`${at}: should be text`);
  const v = oneLine(raw);
  if (opts.required && !v) fail(`${at}: missing`);
  if (v.length > max) fail(`${at}: over ${max} characters`);
  return v;
}

function wordList(raw: unknown, at: string, opts: { min: number; max: number }): string[] {
  if (raw === undefined || raw === null) return opts.min ? fail(`${at}: missing`) : [];
  if (!Array.isArray(raw)) return fail(`${at}: should be a list of words`);
  if (raw.length > opts.max) fail(`${at}: ${opts.max} at most`);
  const list = raw.map((x, i) => words(x, `${at}[${i}]`, CHECKIN_SHARE_LIMITS.option, { required: true }));
  if (new Set(list.map((x) => x.toLowerCase())).size !== list.length) fail(`${at}: each word once`);
  if (list.length < opts.min) fail(`${at}: at least ${opts.min}`);
  return list;
}

function readQuestion(raw: unknown, i: number): SharedCheckinQuestion {
  const at = `questions[${i}]`;
  if (!isObj(raw)) return fail(`${at}: should be a question`);
  const prompt = words(raw.prompt, `${at}.prompt`, CHECKIN_SHARE_LIMITS.prompt, { required: true });
  if (typeof raw.type !== "string" || !(QUESTION_TYPES as readonly string[]).includes(raw.type)) {
    const said = typeof raw.type === "string" ? `“${oneLine(raw.type).slice(0, 30)}”` : "a kind of answer it doesn't name";
    return fail(`Question ${i + 1}, “${prompt.slice(0, 60)}”, is answered with ${said}, which this Athena doesn't know. It knows a scale, choices, life areas and a written answer.`);
  }
  const type = raw.type as QuestionType;
  if (!Array.isArray(raw.kinds) || !raw.kinds.length || raw.kinds.some((k) => !(CHECKIN_KINDS as readonly unknown[]).includes(k)) || new Set(raw.kinds).size !== raw.kinds.length) fail(`${at}.kinds: "morning", "evening" or both`);
  const kinds = CHECKIN_KINDS.filter((k) => (raw.kinds as unknown[]).includes(k));
  const q: SharedCheckinQuestion = { prompt, kinds, type };
  // Only what this type uses is read; a field for another type is left out, like any key Athena doesn't know.
  if (type === "scale") {
    const lead = words(raw.lead, `${at}.lead`, CHECKIN_SHARE_LIMITS.lead);
    const low = words(raw.low, `${at}.low`, CHECKIN_SHARE_LIMITS.end);
    const high = words(raw.high, `${at}.high`, CHECKIN_SHARE_LIMITS.end);
    const levels = wordList(raw.levels, `${at}.levels`, { min: 0, max: 5 });
    if (levels.length && levels.length !== 5) fail(`${at}.levels: five, one for each step from 1 to 5`);
    Object.assign(q, lead ? { lead } : {}, levels.length ? { levels } : {}, low ? { low } : {}, high ? { high } : {});
  } else if (type === "choices" || type === "areas") {
    const options = wordList(raw.options, `${at}.options`, { min: 1, max: CHECKIN_SHARE_LIMITS.options });
    const more = wordList(raw.more, `${at}.more`, { min: 0, max: CHECKIN_SHARE_LIMITS.options });
    if (more.some((m) => options.some((o) => o.toLowerCase() === m.toLowerCase()))) fail(`${at}.more: words not already in options`);
    Object.assign(q, { options }, more.length ? { more } : {});
  } else {
    const placeholder = words(raw.placeholder, `${at}.placeholder`, CHECKIN_SHARE_LIMITS.placeholder);
    if (raw.deeper !== undefined && raw.deeper !== null && typeof raw.deeper !== "boolean") fail(`${at}.deeper: true or false`);
    Object.assign(q, placeholder ? { placeholder } : {}, { deeper: raw.deeper === true });
  }
  return q;
}

/** checkin.json, read and checked. Throws ShareFormatError with words for the owner. Pure. */
export function readSharedCheckins(raw: unknown): SharedCheckins {
  if (!isObj(raw)) throw new ShareFormatError(`That isn't a set of check-in questions: ${CHECKIN_FILE} should hold an object.`);
  if (raw.format !== CHECKIN_SHARE_FORMAT) {
    if (typeof raw.format === "number" && raw.format > CHECKIN_SHARE_FORMAT) throw new ShareFormatError("Those check-in questions were shared from a newer Athena. Update yours, then try again.");
    throw new ShareFormatError(`That isn't a set of check-in questions Athena can read: ${CHECKIN_FILE} needs "format": ${CHECKIN_SHARE_FORMAT}.`);
  }
  const name = words(raw.name, "name", CHECKIN_SHARE_LIMITS.name, { required: true });
  const summary = words(raw.summary, "summary", CHECKIN_SHARE_LIMITS.summary);
  if (!Array.isArray(raw.questions) || !raw.questions.length) fail("questions: at least one question");
  const list = raw.questions as unknown[];
  if (list.length > CHECKIN_SHARE_LIMITS.questions) fail(`questions: ${CHECKIN_SHARE_LIMITS.questions} at most`);
  const questions = list.map(readQuestion);
  const seen = new Set<string>();
  for (const q of questions) {
    const k = samePrompt(q.prompt);
    if (seen.has(k)) fail(`questions: “${q.prompt}” is in it twice`);
    seen.add(k);
  }
  return { format: CHECKIN_SHARE_FORMAT, ...readHeader(raw), name, summary, questions };
}

/** checkin.json as it's written: two-space JSON with a line at the end. Pure. */
export function serialiseSharedCheckins(s: SharedCheckins): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

/**
 * Two questions are the same question when their words are, ignoring case, spacing and the punctuation at the end:
 * "What went well today?" and "what went well today" are one. Pure.
 */
export function samePrompt(prompt: string): string {
  return oneLine(prompt)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[\s.?!…:;,]+$/u, "");
}

/**
 * Where answers to a question from a shared set are copied: the day's journal when Athena's own questions of that
 * type go there (written answers), otherwise nowhere. Never the mood, Health or the briefing, whatever the file says.
 * Pure.
 */
export function sharedMirror(type: QuestionType): CheckinMirror {
  return PRESET_QUESTIONS.some((q) => q.type === type && q.mirror === "day_journal") ? "day_journal" : null;
}

/** Does any question offer Go deeper? A model sees its words, and the owner's answer, only when they tap it. Pure. */
export const offersDeeper = (questions: ReadonlyArray<Pick<SharedCheckinQuestion, "type" | "deeper">>): boolean => questions.some((q) => q.type === "text" && q.deeper === true);

// ---------- making one ----------

/** What exportCheckins needs from the server: the site's own hosts to take out, and the owner's terms to flag. */
export interface CheckinExportContext {
  ownHosts: string[];
  known: KnownTerm[];
  /** The owner's words in the share sheet. They change the file, never the questions. */
  edits?: { name?: string; summary?: string; version?: string; author?: string };
  /** Finding ids the owner said are fine to share. */
  fine?: readonly string[];
  basedOn?: string | null;
}

export interface CheckinExport {
  shared: SharedCheckins;
  removed: Removed[];
  /** What looks like the owner's own: `where` holds "name", "summary" or "question:<n>" (1 for the first). */
  findings: Finding[];
  /** The folder's name: "evening-wind-down". */
  slug: string;
}

/** "evening-wind-down": a set's folder name. Pure. */
export function checkinSlug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "check-in-questions";
}

/** A question as a file carries it: only its words and how it's answered. Pure. */
export function toShared(q: Pick<CheckinQuestion, "prompt" | "kinds" | "type" | "lead" | "levels" | "low" | "high" | "options" | "more" | "placeholder" | "deeper">): SharedCheckinQuestion {
  const out: SharedCheckinQuestion = { prompt: q.prompt, kinds: [...q.kinds], type: q.type };
  if (q.type === "scale") Object.assign(out, q.lead ? { lead: q.lead } : {}, q.levels ? { levels: [...q.levels] } : {}, q.low ? { low: q.low } : {}, q.high ? { high: q.high } : {});
  else if (q.type === "choices" || q.type === "areas") Object.assign(out, { options: [...(q.options ?? [])] }, q.more?.length ? { more: [...q.more] } : {});
  else Object.assign(out, q.placeholder ? { placeholder: q.placeholder } : {}, { deeper: q.deeper === true });
  return out;
}

/**
 * Some of the owner's questions as a file: links into their Athena taken out of every word, the personal-data
 * check run over the name, the summary and each question. Nothing else of theirs goes: no ids, answers, pins or
 * mirrors. Throws ShareFormatError when the result isn't a set Athena can read (no name, no questions). Pure.
 */
export function exportCheckins(questions: readonly CheckinQuestion[], ctx: CheckinExportContext): CheckinExport {
  let removed: Removed[] = [];
  const scrub = (t: string): string => {
    const r = scrubText(t, ctx.ownHosts);
    removed = addRemoved(removed, r.removed);
    return oneLine(r.text);
  };
  const scrubList = (xs: readonly string[] | undefined) => (xs ? xs.map(scrub) : undefined);
  const edits = ctx.edits ?? {};
  const shared: SharedCheckinQuestion[] = questions.map((q) =>
    toShared({ ...q, prompt: scrub(q.prompt), lead: q.lead && scrub(q.lead), low: q.low && scrub(q.low), high: q.high && scrub(q.high), levels: scrubList(q.levels) as CheckinQuestion["levels"], options: scrubList(q.options), more: scrubList(q.more), placeholder: q.placeholder && scrub(q.placeholder) }),
  );
  const name = scrub(oneLine(edits.name ?? "").slice(0, CHECKIN_SHARE_LIMITS.name));
  const summary = scrub(oneLine(edits.summary ?? "").slice(0, CHECKIN_SHARE_LIMITS.summary));
  if (!name) throw new ShareFormatError("Give the questions a name first.");
  if (!shared.length) throw new ShareFormatError("Pick at least one question to share.");
  const result = readSharedCheckins({ format: CHECKIN_SHARE_FORMAT, name, summary, questions: shared, version: edits.version, author: edits.author, based_on: ctx.basedOn ?? undefined });
  const fields: CheckField[] = [
    { field: "name", text: name },
    { field: "summary", text: summary },
    ...result.questions.map((q, i) => ({ field: `question:${i + 1}`, text: [q.prompt, q.lead, ...(q.levels ?? []), q.low, q.high, ...(q.options ?? []), ...(q.more ?? []), q.placeholder].filter(Boolean).join("\n") })),
  ];
  return { shared: result, removed, findings: findPersonal(fields, ctx.known, ctx.fine ?? []), slug: checkinSlug(name) };
}

// ---------- adding one ----------

/** What joining a set did. */
export interface JoinResult {
  settings: CheckinSettings;
  /** The new questions' ids, in the set's order. */
  added: string[];
  /** Questions skipped because the owner already has their words, as the set words them. */
  skipped: string[];
  /** Routines the new questions joined that are switched off. They stay off. */
  off: CheckinKind[];
  /** Questions left out because the owner's own questions reached MAX_OWN_QUESTIONS, as the set words them. */
  full: string[];
}

/** The prompts already in a set-up, Athena's and the owner's, as samePrompt gives them. Pure. */
export function promptsHere(settings: Pick<CheckinSettings, "own">): Set<string> {
  return new Set([...PRESET_QUESTIONS, ...settings.own].map((q) => samePrompt(q.prompt)));
}

/**
 * A shared set joined to a set-up: each question whose words aren't already here becomes one of the owner's own
 * (a new id from `newId`, `set` naming where it came from, its answers copied where `sharedMirror` says) and goes at the end of each
 * routine it's asked in, unpinned. Nothing already there moves or changes, and no routine is switched on. Past
 * MAX_OWN_QUESTIONS of the owner's own, the rest are left out and named in `full`. Pure.
 */
export function joinSharedCheckins(settings: CheckinSettings, shared: SharedCheckins, opts: { setId: string; newId: () => string }): JoinResult {
  const next: CheckinSettings = structuredClone(settings);
  const have = promptsHere(next);
  const fresh: SharedCheckinQuestion[] = [];
  const skipped: string[] = [];
  for (const q of shared.questions) {
    const k = samePrompt(q.prompt);
    if (have.has(k)) skipped.push(q.prompt);
    else {
      fresh.push(q);
      have.add(k);
    }
  }
  const room = Math.max(0, MAX_OWN_QUESTIONS - next.own.length);
  const full = fresh.splice(room).map((q) => q.prompt);
  const added: string[] = [];
  const joined = new Set<CheckinKind>();
  for (const q of fresh) {
    const id = opts.newId();
    next.own.push({ ...toShared(q), id, mirror: sharedMirror(q.type), preset: false, set: opts.setId });
    for (const k of q.kinds) {
      next[k].questions.push({ id, pinned: false });
      joined.add(k);
    }
    added.push(id);
  }
  return { settings: next, added, skipped, off: CHECKIN_KINDS.filter((k) => joined.has(k) && !next[k].enabled), full };
}

/** A set-up with a set's questions taken out of the owner's own and of both routines. Nothing else changes. Pure. */
export function removeSetFrom(settings: CheckinSettings, setId: string): CheckinSettings {
  const next: CheckinSettings = structuredClone(settings);
  const gone = new Set(next.own.filter((q) => q.set === setId).map((q) => q.id));
  next.own = next.own.filter((q) => !gone.has(q.id));
  for (const k of CHECKIN_KINDS) next[k].questions = next[k].questions.filter((x) => !gone.has(x.id));
  return next;
}

/** The questions a day's plan may pick from: a switched-off set's are passed over until it's back on. Pure. */
export function askable(library: readonly CheckinQuestion[], pausedSets: ReadonlySet<string>): CheckinQuestion[] {
  return library.filter((q) => !q.set || !pausedSets.has(q.set));
}

/** A set's questions as they are here now, in a shared form: for its reach on the Update banner. Pure. */
export function setQuestions(settings: Pick<CheckinSettings, "own">, setId: string): SharedCheckinQuestion[] {
  return settings.own.filter((q) => q.set === setId).map(toShared);
}
