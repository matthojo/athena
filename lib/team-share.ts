/**
 * Shared assistants: a Team assistant as a file someone else can add to their own
 * Athena. Pure and shared with the app (sample mode reads and checks one
 * here too). The server side is lib/team-share-store.ts.
 *
 * A shared assistant is a folder, usually zipped:
 *
 *   <slug>/assistant.json   the assistant: name, job, instructions, looks,
 *                          triggers, the questions it asks whoever adds it,
 *                          the accounts it needs, and what it would like to
 *                          do without asking (a request, never a grant)
 *   <slug>/SKILL.md        its skill, in Claude's format (optional)
 *   <slug>/…               the skill's reference files (.md .txt .csv .json)
 *
 * What never goes in: memory, runs, conversations, model choices, connector
 * ids, record ids, links to the owner's own site. Before a download,
 * `scrubText` takes out links to the site and `athena://` links, and
 * `findPersonal` flags anything that looks like the owner's own people,
 * places, addresses, email addresses, phone numbers or private links; the
 * owner edits it out, or says it's fine to share.
 *
 * Reading one (`readShared`) treats every field as someone else's words:
 * checked against the same limits as an assistant made in Athena, unknown
 * keys dropped, and nothing in it is a permission. On import the assistant
 * starts paused, with nothing allowed to run alone unless the owner ticks it.
 */
import { checkFiles, cleanPath, intakeEntries, SkillFormatError, textOf, type IntakeEntry, type SkillFile, type SkillPreview, type SkillSkipped, type SkillSource } from "./skills";
import { MAX_ANSWER, MAX_CHOICE, MAX_CHOICES, MAX_QUESTION, MAX_QUESTIONS, MAX_SUMMARY, type TeamAnswer } from "./team-skill";
import { EVERYDAY } from "./todo-person";
import { sharedToolAllowed, type AccountRow } from "./shared-limits";
import {
  ACCENT_KEYS,
  ACCESSORY_IDS,
  ACCESSORY_LIST,
  EVENT_SOURCES,
  EYES,
  FUR_KEYS,
  MAX_GREETING,
  MAX_INSTRUCTIONS,
  MAX_JOB,
  MAX_NAME,
  MAX_TRAITS,
  MAX_TRIGGERS,
  MOUTH_IDS,
  OUTFITS,
  OUTFIT_COLOR_KEYS,
  PRONOUNS,
  SPECIES,
  TONES,
  type AvatarSpec,
  type EventFilter,
  type Personality,
  type TeamAssistant,
  type TeamTriggerInput,
} from "./team-types";

export const SHARE_FORMAT = 1;
export const ASSISTANT_FILE = "assistant.json";
/** Accounts a shared can say it needs. */
export const MAX_NEEDS = 10;
/** Tools it can ask to run without asking. */
export const MAX_WOULD_LIKE = 20;

export class ShareFormatError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ShareFormatError";
  }
}

/** A question the assistant asks whoever adds it. Their answer goes into its skill. */
export interface SharedAsk {
  question: string;
  /** Answers to tap. Empty: they write their own. */
  choices: string[];
}

/** A trigger as a shared assistant carries it: no ids, no last run. */
export interface SharedTrigger {
  kind: "schedule" | "event";
  /** schedule: 0 = Sunday … 6 = Saturday. */
  days?: number[];
  /** schedule: HH:MM in whoever adds it's own time zone. */
  time?: string;
  event?: EventFilter;
}

export interface SharedAssistant {
  format: typeof SHARE_FORMAT;
  name: string;
  job: string;
  instructions: string;
  /** One or two sentences on how it works, for the preview. */
  summary: string;
  personality: Personality | null;
  avatar: AvatarSpec | null;
  triggers: SharedTrigger[];
  asks: SharedAsk[];
  /** Accounts it needs, by provider ("linear", "gmail"). */
  needs: string[];
  /** Tools it would like to run without asking. Shown unticked on import. */
  would_like: string[];
  /** It would like to look things up online. Off on import unless ticked. */
  web: boolean;
  /** Free text, like 1.2.0. */
  version?: string;
  /** A GitHub username, if the author wants credit. */
  author?: string;
  /** The shared this one was made from: a github.com link. */
  based_on?: string;
}

/** A shared assistant's skill: SKILL.md's body and its reference files. */
export interface SharedSkill {
  body: string;
  files: SkillFile[];
  skipped: SkillSkipped[];
}

/** What an import would add, shown whole before anything is kept. */
export interface SharedBundle {
  shared: SharedAssistant;
  skill: SharedSkill | null;
  source: SkillSource;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- reading one ----------

function text(raw: unknown, field: string, max: number, opts: { required?: boolean; multiline?: boolean } = {}): string {
  if (raw === undefined || raw === null) {
    if (opts.required) throw new ShareFormatError(`${field}: missing`);
    return "";
  }
  if (typeof raw !== "string") throw new ShareFormatError(`${field}: should be text`);
  const v = opts.multiline ? raw.replace(/\r\n?/g, "\n").trim() : oneLine(raw);
  if (opts.required && !v) throw new ShareFormatError(`${field}: missing`);
  if (v.length > max) throw new ShareFormatError(`${field}: over ${max.toLocaleString("en-GB")} characters`);
  return v;
}

const inList = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);

/** Its looks, when they're ones Athena can draw; otherwise null (whoever adds it gets a fresh character). */
function readAvatar(raw: unknown): AvatarSpec | null {
  if (!isObj(raw)) return null;
  const acc = Array.isArray(raw.accessories) ? raw.accessories : [];
  const ok =
    raw.v === 1 &&
    typeof raw.seed === "string" &&
    raw.seed.length > 0 &&
    raw.seed.length <= 64 &&
    inList(SPECIES, raw.species) &&
    inList(FUR_KEYS, raw.fur) &&
    inList(ACCENT_KEYS, raw.accent) &&
    inList(EYES, raw.eyes) &&
    inList(MOUTH_IDS, raw.mouth) &&
    inList(OUTFITS, raw.outfit) &&
    inList(OUTFIT_COLOR_KEYS, raw.outfitColor) &&
    acc.length <= 3 &&
    acc.every((a) => inList(ACCESSORY_LIST, a)) &&
    new Set(acc.map((a) => ACCESSORY_IDS[a as keyof typeof ACCESSORY_IDS])).size === acc.length;
  if (!ok) return null;
  return { v: 1, seed: raw.seed as string, species: raw.species, fur: raw.fur, accent: raw.accent, eyes: raw.eyes, mouth: raw.mouth, outfit: raw.outfit, outfitColor: raw.outfitColor, accessories: acc } as AvatarSpec;
}

function readPersonality(raw: unknown): Personality | null {
  if (!isObj(raw) || !inList(TONES, raw.tone) || !inList(PRONOUNS, raw.pronoun)) return null;
  const traits = (Array.isArray(raw.traits) ? raw.traits : []).filter((t): t is string => typeof t === "string").map(oneLine).filter((t) => t && t.length <= 30).slice(0, MAX_TRAITS);
  const greeting = typeof raw.greeting === "string" ? oneLine(raw.greeting).slice(0, MAX_GREETING) : "";
  return { tone: raw.tone as Personality["tone"], pronoun: raw.pronoun as Personality["pronoun"], traits, greeting };
}

function readTrigger(raw: unknown, i: number): SharedTrigger {
  const at = `triggers[${i}]`;
  if (!isObj(raw)) throw new ShareFormatError(`${at}: should be an object`);
  if (raw.kind === "schedule") {
    const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
    if (!days.length) throw new ShareFormatError(`${at}: a schedule needs days, 0 (Sunday) to 6`);
    if (typeof raw.time !== "string" || !TIME.test(raw.time)) throw new ShareFormatError(`${at}: a schedule needs a time, like 08:30`);
    return { kind: "schedule", days, time: raw.time };
  }
  if (raw.kind === "event") {
    const e = raw.event;
    if (!isObj(e) || !inList(EVENT_SOURCES, e.source)) throw new ShareFormatError(`${at}: an event trigger needs event.source (collected, saved or note)`);
    const facet = (k: string, max: number) => {
      const v = e[k];
      if (v === undefined || v === null || v === "") return undefined;
      return text(v, `${at}.event.${k}`, max) || undefined;
    };
    const event: EventFilter = { source: e.source as EventFilter["source"] };
    const connector = facet("connector", 80);
    if (connector) event.connector = connector.toLowerCase();
    const kind = facet("kind", 80);
    if (kind) event.kind = kind;
    const savedAction = facet("savedAction", 80);
    if (savedAction) event.savedAction = savedAction;
    const tag = facet("tag", 80);
    if (tag) event.tag = tag.replace(/^#/, "");
    const match = facet("match", 120);
    if (match) event.match = match;
    return { kind: "event", event };
  }
  throw new ShareFormatError(`${at}: kind should be schedule or event`);
}

function readAsks(raw: unknown): SharedAsk[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ShareFormatError("asks: should be a list");
  const out: SharedAsk[] = [];
  for (const [i, a] of raw.entries()) {
    const q = isObj(a) ? a.question : a;
    const question = text(q, `asks[${i}].question`, MAX_QUESTION);
    if (!question || out.some((x) => x.question.toLowerCase() === question.toLowerCase())) continue;
    const choices = [...new Set((isObj(a) && Array.isArray(a.choices) ? a.choices : []).filter((c): c is string => typeof c === "string").map(oneLine).filter((c) => c && c.length <= MAX_CHOICE))].slice(0, MAX_CHOICES);
    out.push({ question, choices: choices.length >= 2 ? choices : [] });
  }
  if (out.length > MAX_QUESTIONS) throw new ShareFormatError(`asks: ${MAX_QUESTIONS} questions at most`);
  return out;
}

function names(raw: unknown, field: string, re: RegExp, max: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ShareFormatError(`${field}: should be a list`);
  const out = [...new Set(raw.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()).filter((v) => re.test(v)))];
  if (out.length > max) throw new ShareFormatError(`${field}: ${max} at most`);
  return out;
}

/** A github.com link, or nothing: a shared only ever points back at GitHub. */
export function githubLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 300) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return undefined;
    return `https://github.com${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** The accounts its event triggers wait on, then the ones it says it needs. Pure. */
export function needsOf(triggers: readonly SharedTrigger[], declared: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const t of triggers) if (t.event?.connector && PROVIDER.test(t.event.connector) && !out.includes(t.event.connector)) out.push(t.event.connector);
  for (const d of declared) if (!out.includes(d)) out.push(d);
  return out.slice(0, MAX_NEEDS);
}

/** assistant.json, read and checked. Throws ShareFormatError with words for the owner. Pure. */
export function readShared(raw: unknown): SharedAssistant {
  if (!isObj(raw)) throw new ShareFormatError("That isn't a shared assistant: assistant.json should hold an object.");
  if (raw.format !== SHARE_FORMAT) {
    if (typeof raw.format === "number" && raw.format > SHARE_FORMAT) throw new ShareFormatError("That assistant was shared from a newer Athena. Update yours, then try again.");
    throw new ShareFormatError(`That isn't an assistant Athena can read: assistant.json needs "format": ${SHARE_FORMAT}.`);
  }
  const triggersRaw = raw.triggers ?? [];
  if (!Array.isArray(triggersRaw)) throw new ShareFormatError("triggers: should be a list");
  if (triggersRaw.length > MAX_TRIGGERS) throw new ShareFormatError(`triggers: ${MAX_TRIGGERS} at most`);
  const triggers = triggersRaw.map(readTrigger);
  const version = typeof raw.version === "string" && VERSION.test(raw.version.trim()) ? raw.version.trim() : undefined;
  const author = typeof raw.author === "string" && GITHUB_USER.test(raw.author.trim().replace(/^@/, "")) ? raw.author.trim().replace(/^@/, "") : undefined;
  const basedOn = githubLink(raw.based_on);
  return {
    format: SHARE_FORMAT,
    name: text(raw.name, "name", MAX_NAME),
    job: text(raw.job, "job", MAX_JOB, { required: true }),
    instructions: text(raw.instructions, "instructions", MAX_INSTRUCTIONS, { multiline: true }),
    summary: text(raw.summary, "summary", MAX_SUMMARY),
    personality: readPersonality(raw.personality),
    avatar: readAvatar(raw.avatar),
    triggers,
    asks: readAsks(raw.asks),
    needs: needsOf(triggers, names(raw.needs, "needs", PROVIDER, MAX_NEEDS)),
    would_like: names(raw.would_like, "would_like", TOOL, MAX_WOULD_LIKE),
    web: raw.web === true,
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
    ...(basedOn ? { based_on: basedOn } : {}),
  };
}

/** assistant.json as written: keys in a fixed order, empty optional ones left out. Pure. */
export function serialiseShared(w: SharedAssistant): string {
  const out: Record<string, unknown> = { format: w.format, name: w.name, job: w.job };
  if (w.version) out.version = w.version;
  if (w.author) out.author = w.author;
  if (w.based_on) out.based_on = w.based_on;
  if (w.summary) out.summary = w.summary;
  out.instructions = w.instructions;
  out.triggers = w.triggers.map((t) => (t.kind === "schedule" ? { kind: t.kind, days: t.days, time: t.time } : { kind: t.kind, event: t.event }));
  out.asks = w.asks.map((a) => (a.choices.length ? a : { question: a.question }));
  out.needs = w.needs;
  out.would_like = w.would_like;
  out.web = w.web;
  if (w.personality) out.personality = w.personality;
  if (w.avatar) out.avatar = w.avatar;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The triggers as POST /api/team takes them. Pure. */
export function triggerInputs(w: SharedAssistant): TeamTriggerInput[] {
  return w.triggers.map((t) => (t.kind === "schedule" ? { kind: "schedule", days: t.days, time: t.time } : { kind: "event", event: t.event }));
}

// ---------- a folder, zip or link's files ----------

const isAssistantFile = (path: string) => (path.split("/").pop() ?? "").toLowerCase() === ASSISTANT_FILE;

/**
 * A shared from a folder's or zip's files: the shallowest assistant.json,
 * and the SKILL.md and files beside it (lib/skills.ts intakeEntries, so the
 * same caps apply). A folder with no SKILL.md is fine: Athena writes the
 * skill on import. Throws ShareFormatError. Pure.
 */
export function bundleFromEntries(entries: IntakeEntry[], source: SkillSource): SharedBundle {
  const clean = entries.flatMap((e) => {
    const path = cleanPath(e.path);
    return path && !path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX") ? [{ ...e, path }] : [];
  });
  const found = clean.filter((e) => isAssistantFile(e.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  if (!found.length) {
    if (clean.some((e) => /(^|\/)skill\.md$/i.test(e.path))) throw new ShareFormatError("That's a skill, not an assistant. Add it in Settings → Ask → Skills.");
    throw new ShareFormatError("There's no assistant.json in that.");
  }
  const depth = found[0].path.split("/").length;
  if (found.filter((e) => e.path.split("/").length === depth).length > 1) throw new ShareFormatError("That holds more than one assistant. Import them one at a time.");
  const root = found[0].path.split("/").slice(0, -1).join("/");
  const json = textOf(found[0].bytes);
  if (json === null) throw new ShareFormatError("assistant.json isn't readable text.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ShareFormatError("assistant.json isn't valid JSON.");
  }
  const shared = readShared(parsed);
  const beside = clean.filter((e) => e !== found[0] && (!root || e.path.startsWith(`${root}/`)) && !isAssistantFile(e.path));
  const inRoot = (p: string) => (root ? p.slice(root.length + 1) : p);
  // Only a SKILL.md at the shared assistant's own level is its skill.
  const hasSkill = beside.some((e) => inRoot(e.path).toLowerCase() === "skill.md");
  let skill: SharedSkill | null = null;
  if (hasSkill) {
    let p: SkillPreview;
    try {
      p = intakeEntries(beside, source);
    } catch (error) {
      if (error instanceof SkillFormatError) throw new ShareFormatError(`Its skill: ${error.message}`);
      throw error;
    }
    skill = { body: p.body, files: p.files, skipped: p.skipped };
  }
  return { shared, skill, source };
}

/** assistant.json on its own (and a SKILL.md, if one came with it). Pure. */
export function bundleFromText(json: string, source: SkillSource, skillMd?: string): SharedBundle {
  const entries: IntakeEntry[] = [{ path: ASSISTANT_FILE, bytes: new TextEncoder().encode(json) }];
  if (skillMd) entries.push({ path: "SKILL.md", bytes: new TextEncoder().encode(skillMd) });
  return bundleFromEntries(entries, source);
}

// ---------- making one ----------

/** "Gift price watcher" → "gift-price-watcher": the folder and zip's name. Pure. */
export function shareSlug(name: string, job: string): string {
  const s = `${name || job}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "assistant";
}

/** The seed for its character when it brings no looks: the same in the preview and once added. Pure. */
export function shareSeed(w: Pick<SharedAssistant, "name" | "job">): string {
  return `wf-${shareSlug(w.name, w.job)}`.slice(0, 64);
}

/** What the owner can change in the export sheet before downloading. Changes apply to the file, not the assistant. */
export interface ShareEdits {
  name?: string;
  job?: string;
  instructions?: string;
  summary?: string;
  skill?: string;
  greeting?: string;
  asks?: SharedAsk[];
  version?: string;
  author?: string;
  /** Leave its looks out: whoever adds it gets a fresh character. */
  no_avatar?: boolean;
}

/**
 * An assistant as a file to share, with the owner's edits. The setup questions
 * kept with its skill become the questions it asks whoever adds it; the
 * owner's own answers never go. Pure.
 */
export function sharedFromAssistant(a: Pick<TeamAssistant, "name" | "job" | "instructions" | "personality" | "avatar" | "triggers" | "allow" | "web">, opts: { summary?: string; answers?: TeamAnswer[]; edits?: ShareEdits } = {}): SharedAssistant {
  const e = opts.edits ?? {};
  const asks = e.asks ?? (opts.answers ?? []).map((x) => ({ question: x.question, choices: [] }));
  const triggers: SharedTrigger[] = a.triggers.map((t) => (t.kind === "schedule" ? { kind: "schedule", days: [...t.days], time: t.time ?? "09:00" } : { kind: "event", event: { ...(t.event as EventFilter) } }));
  const personality = { ...a.personality, ...(e.greeting !== undefined ? { greeting: oneLine(e.greeting).slice(0, MAX_GREETING) } : {}) };
  const raw = {
    format: SHARE_FORMAT,
    name: e.name ?? a.name,
    job: e.job ?? a.job,
    instructions: e.instructions ?? a.instructions,
    summary: e.summary ?? opts.summary ?? "",
    personality,
    avatar: e.no_avatar ? null : a.avatar,
    triggers,
    asks: asks.slice(0, MAX_QUESTIONS),
    needs: [],
    would_like: a.allow,
    web: a.web === true,
    version: e.version,
    author: e.author,
  };
  return readShared(raw);
}

// ---------- taking out the site's own links ----------

export type RemovedKind = "athena-link" | "site-link" | "record-id";

export interface Removed {
  kind: RemovedKind;
  count: number;
}

const UUID_G = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with links into the owner's Athena taken out: `athena://` links (a
 * Markdown link keeps its label), links to the site's own hosts, and record
 * ids. Counted, so the sheet can say what went. Pure.
 */
export function scrubText(input: string, ownHosts: readonly string[]): { text: string; removed: Removed[] } {
  const counts: Record<RemovedKind, number> = { "athena-link": 0, "site-link": 0, "record-id": 0 };
  let s = input;
  const hosts = ownHosts.map((h) => h.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  const hostRe = hosts.length ? new RegExp(`https?://(?:www\\.)?(?:${hosts.map(escapeRe).join("|")})(?::\\d+)?(?:[/?#][^\\s)\\]>"']*)?`, "gi") : null;
  const md = /\[([^\]\n]{0,200})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  s = s.replace(md, (whole, label: string, href: string) => {
    if (/^athena:/i.test(href)) {
      counts["athena-link"]++;
      return label;
    }
    if (hostRe && new RegExp(hostRe.source, "i").test(href)) {
      counts["site-link"]++;
      return label;
    }
    return whole;
  });
  s = s.replace(/<?athena:\/\/[^\s)\]>"']+>?/gi, () => {
    counts["athena-link"]++;
    return "";
  });
  if (hostRe)
    s = s.replace(hostRe, () => {
      counts["site-link"]++;
      return "";
    });
  s = s.replace(UUID_G, () => {
    counts["record-id"]++;
    return "";
  });
  const removed = (Object.keys(counts) as RemovedKind[]).filter((k) => counts[k] > 0).map((kind) => ({ kind, count: counts[kind] }));
  if (!removed.length) return { text: input, removed };
  // Tidy what the cuts left: doubled spaces and empty brackets, not the line breaks.
  s = s.replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "");
  return { text: s, removed };
}

/** Two lists of what was taken out, added together. Pure. */
export function addRemoved(a: Removed[], b: Removed[]): Removed[] {
  const out = new Map<RemovedKind, number>();
  for (const r of [...a, ...b]) out.set(r.kind, (out.get(r.kind) ?? 0) + r.count);
  return [...out].map(([kind, count]) => ({ kind, count }));
}

// ---------- the personal-data check ----------

export type KnownKind = "you" | "person" | "place" | "address" | "organisation" | "project" | "email" | "phone" | "account";

/** Something from the owner's own Athena that shouldn't leave it: a name, an address, an email address. */
export interface KnownTerm {
  term: string;
  kind: KnownKind;
  /** A first name: counted only when written with a capital, as a name. */
  loose?: boolean;
}

export type FindingKind = KnownKind | "link";

export interface Finding {
  /** Stable across checks, so "It's fine" sticks: kind and term, lowercased. */
  id: string;
  kind: FindingKind;
  /** As it's written in the text. */
  term: string;
  /** The fields it's in: "job", "instructions", "skill", "file:notes.md"… */
  where: string[];
}

export interface CheckField {
  field: string;
  text: string;
}

/** Names that say nothing about anyone: never flagged as a place or an organisation. */
const GENERIC = new Set(["home", "work", "office", "gym", "school", "the office", "kitchen", "garden", "shop", "station", "airport", "hospital", "church", "park", "pub", "cafe", "café", "bank"]);
/** Addresses and domains made up for examples. */
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|invalid|localhost)$/i;
/** Ofcom's drama numbers: 07700 900000 to 07700 900999. */
const DRAMA_PHONE = /^(?:44|0)?7700900\d{3}$/;
/** Hosts whose links usually point at someone's own documents, chats or calls. */
const PRIVATE_HOSTS = /(^|\.)(docs\.google\.com|drive\.google\.com|calendar\.google\.com|mail\.google\.com|meet\.google\.com|notion\.so|notion\.site|slack\.com|linear\.app|atlassian\.net|dropbox\.com|figma\.com|zoom\.us|teams\.microsoft\.com|sharepoint\.com|onedrive\.live\.com|outlook\.office\.com|outlook\.live\.com|netlify\.app|airtable\.com|trello\.com|miro\.com|loom\.com|calendly\.com)$/i;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/’/g, "'");
const digits = (s: string) => s.replace(/\D/g, "");

/** A term as a whole-word pattern, any case: letters and digits on neither side. */
function wordRe(term: string): RegExp {
  const body = escapeRe(fold(term).trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * What in these fields looks like the owner's own: their known people,
 * places, addresses, organisations and projects (whole words; a first name
 * only when it's written as a name), email addresses and phone numbers that
 * aren't made-up ones, and links to private documents. `fine` holds finding
 * ids the owner said are fine to share. Pure.
 */
export function findPersonal(fields: CheckField[], known: KnownTerm[], fine: readonly string[] = []): Finding[] {
  const found = new Map<string, Finding>();
  const ok = new Set(fine.map((f) => f.toLowerCase()));
  const add = (kind: FindingKind, term: string, field: string) => {
    const id = `${kind}:${fold(term).toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (ok.has(id)) return;
    const had = found.get(id);
    if (had) {
      if (!had.where.includes(field)) had.where.push(field);
    } else found.set(id, { id, kind, term: term.trim(), where: [field] });
  };

  // Longer names first, so "Priya Shah" is found before "Priya", and the shorter isn't counted inside it.
  const terms = known
    .map((k) => ({ ...k, term: oneLine(k.term) }))
    .filter((k) => {
      const t = k.term.toLowerCase();
      if (t.length < 3) return false;
      if ((k.kind === "place" || k.kind === "organisation" || k.kind === "project") && GENERIC.has(t)) return false;
      if (k.kind === "email") return !EXAMPLE_DOMAIN.test(t.split("@")[1] ?? "");
      if (k.kind === "phone") return digits(t).length >= 7 && !DRAMA_PHONE.test(digits(t));
      if (k.loose && EVERYDAY.has(t)) return false;
      return true;
    })
    .sort((a, b) => b.term.length - a.term.length);

  for (const { field, text: raw } of fields) {
    if (!raw) continue;
    let rest = fold(raw);
    for (const k of terms) {
      if (k.kind === "phone") continue;
      // A loose term (a first name, a nickname kept lowercased) matches in any case, then counts only when written with a capital.
      const re = wordRe(k.term);
      rest = rest.replace(re, (m) => {
        if (k.loose && !/^\p{Lu}/u.test(m)) return m;
        add(k.kind, m, field);
        return " ".repeat(m.length);
      });
    }
    // Email addresses: known or not, unless they're made up.
    for (const m of raw.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
      if (EXAMPLE_DOMAIN.test(m[1])) continue;
      if (!found.has(`email:${m[0].toLowerCase()}`)) add("email", m[0], field);
    }
    // Phone numbers: 10 or more digits in a row (spaces, dots, dashes and brackets allowed), unless made up.
    for (const m of raw.matchAll(/(?<![\w+])\+?\(?\d[\d\s().-]{8,}\d(?!\w)/g)) {
      const d = digits(m[0]);
      if (d.length < 10 || d.length > 15 || DRAMA_PHONE.test(d)) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(m[0].trim())) continue;
      add("phone", m[0], field);
    }
    // Links into someone's own documents, chats and calls.
    for (const m of raw.matchAll(/https?:\/\/([^\s/?#)\]>"']+)[^\s)\]>"']*/gi)) {
      const host = m[1].toLowerCase().replace(/:\d+$/, "");
      // A sentence's full stop or comma isn't part of the link.
      if (PRIVATE_HOSTS.test(host)) add("link", m[0].replace(/[.,;:!?]+$/, ""), field);
    }
  }
  return [...found.values()];
}

/** Every field a shared and its skill carry, for the check. Pure. */
export function checkFields(w: SharedAssistant, skill: { body: string; files: SkillFile[] } | null): CheckField[] {
  const out: CheckField[] = [
    { field: "name", text: w.name },
    { field: "job", text: w.job },
    { field: "summary", text: w.summary },
    { field: "instructions", text: w.instructions },
    { field: "greeting", text: w.personality?.greeting ?? "" },
    { field: "traits", text: (w.personality?.traits ?? []).join(", ") },
    { field: "asks", text: w.asks.map((a) => [a.question, ...a.choices].join("\n")).join("\n") },
    { field: "triggers", text: w.triggers.map((t) => [t.event?.match, t.event?.tag].filter(Boolean).join("\n")).join("\n") },
  ];
  if (skill) {
    out.push({ field: "skill", text: skill.body });
    for (const f of skill.files) out.push({ field: `file:${f.path}`, text: f.text });
  }
  return out;
}

// ---------- adding one ----------

/** The answers whoever adds it gave, as a section of its skill. Pure. */
export function answersSection(answers: TeamAnswer[]): string {
  const clean = answers.map((a) => ({ question: oneLine(a.question).slice(0, MAX_QUESTION), answer: oneLine(a.answer).slice(0, MAX_ANSWER) })).filter((a) => a.question && a.answer);
  if (!clean.length) return "";
  return ["## What your owner told you when they added you", "", ...clean.map((a) => `- ${a.question} ${a.answer}`)].join("\n");
}

/** A skill's body with the answers added at the end. Pure. */
export function withAnswers(body: string, answers: TeamAnswer[]): string {
  const extra = answersSection(answers);
  return extra ? `${body.trim()}\n\n${extra}\n` : body;
}

/**
 * The tools it may run alone: only ones it asked for, the owner ticked, and an import may grant at all (changes
 * inside Athena that keep an Undo, and `track`: lib/shared-limits.ts). Pure.
 */
export function grantedTools(w: Pick<SharedAssistant, "would_like">, ticked: unknown): string[] {
  const asked = new Set(w.would_like);
  return [...new Set((Array.isArray(ticked) ? ticked : []).filter((t): t is string => typeof t === "string" && asked.has(t) && sharedToolAllowed(t)))];
}

/** Hosts its words link to, other than GitHub: shown on the preview, since nothing there was checked. Pure. */
export function linkedHosts(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts)
    for (const m of t.matchAll(/https?:\/\/([^\s/?#)\]>"']+)/gi)) {
      const host = m[1].toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
      if (host !== "github.com" && host !== "raw.githubusercontent.com") out.add(host);
    }
  return [...out].sort().slice(0, 10);
}

/** Reference files sent back on import, checked again. Throws ShareFormatError. Pure. */
export function sharedSkillFiles(raw: unknown): SkillFile[] {
  try {
    return checkFiles(raw);
  } catch (error) {
    if (error instanceof SkillFormatError) throw new ShareFormatError(`Its skill: ${error.message}`);
    throw error;
  }
}

// ---------- what the routes answer (lib/team-share-store.ts, netlify/lib/team-routes.ts) ----------

/** POST /api/team/<id>/export: the file as it would be downloaded, and what to look at first. */
export interface ShareExport {
  shared: SharedAssistant;
  skill: SharedSkill | null;
  /** What looks like the owner's own, still in the text. A download waits until each is edited out or marked fine. */
  findings: Finding[];
  /** Links and ids into the owner's Athena, taken out for them. */
  removed: Removed[];
  /** The folder and zip's name. */
  slug: string;
}

/** An account a shared needs, and whether this Athena has it connected. */
export interface ImportNeed {
  id: string;
  connected: boolean;
}

/** Everything an import would add, before anything is kept: sample mode's Add (app/src/db/team-share.ts addImported). */
export interface ImportPreview extends SharedBundle {
  needs: ImportNeed[];
  /** What it asked to do alone that an import can't grant: these always wait for the owner's Go. `shared.would_like` holds only the rest. */
  asks_first: string[];
  /** This Athena's connected accounts, the ones it needs first: one tick each, all unticked. */
  accounts: AccountRow[];
  /** Sites its words link to, other than GitHub. */
  links: string[];
  /** There's room on the team for it. */
  room: boolean;
}

/** What importAssistant takes, from the Add screen's POST /api/community/add: the file's words and the owner's choices. */
export interface ImportInput {
  shared: SharedAssistant;
  skill: { body: string; files: SkillFile[]; skipped?: SkillSkipped[] } | null;
  source: SkillSource;
  answers: TeamAnswer[];
  /** Tools ticked to run without asking: only ones it asked for count. */
  allow: string[];
  web: boolean;
  /** Connected accounts ticked for it (ids). None ticked: it opens none. */
  accounts?: string[];
}

// ---------- a link to one ----------

/** A GitHub folder, as lib/skill-fetch.ts reads one. */
export interface ShareLink {
  kind: "github";
  owner: string;
  repo: string;
  ref: string | null;
  path: string;
}

const GH_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Where a link's assistant is: a folder on github.com (…/tree/<ref>/<path>),
 * a file in it (…/blob/<ref>/<path>/assistant.json or SKILL.md, read as its
 * folder), or the same file on raw.githubusercontent.com. Anything else is
 * refused: shared assistants come from GitHub, never from someone's own site.
 * Throws ShareFormatError. Pure.
 */
export function parseShareLink(raw: string): ShareLink {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ShareFormatError("That isn't a link.");
  }
  if (u.protocol !== "https:") throw new ShareFormatError("Only https links can be imported.");
  if (u.username || u.password) throw new ShareFormatError("Leave the sign-in out of the link.");
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts.some((p) => p === ".." || p === ".")) throw new ShareFormatError("That link doesn't point at a folder.");
  const fileToFolder = (rest: string[]) => {
    const last = (rest[rest.length - 1] ?? "").toLowerCase();
    if (last === ASSISTANT_FILE || last === "skill.md") return rest.slice(0, -1).join("/");
    throw new ShareFormatError("Link to the assistant's folder on GitHub, or to its assistant.json.");
  };
  if (host === "raw.githubusercontent.com") {
    const [owner, repo, ref, ...rest] = parts;
    if (!owner || !repo || !ref || !GH_NAME.test(owner) || !GH_NAME.test(repo)) throw new ShareFormatError("That link doesn't point at an assistant on GitHub.");
    return { kind: "github", owner, repo, ref, path: fileToFolder(rest) };
  }
  if (host !== "github.com" && host !== "www.github.com") throw new ShareFormatError("Athena imports assistants from GitHub. For anything else, download the file and upload it.");
  const [owner, repo, mode, ref, ...rest] = parts;
  const r = (repo ?? "").replace(/\.git$/, "");
  if (!owner || !r || !GH_NAME.test(owner) || !GH_NAME.test(r)) throw new ShareFormatError("That GitHub link doesn't point at a repository.");
  if (!mode) return { kind: "github", owner, repo: r, ref: null, path: "" };
  if (!ref || (mode !== "tree" && mode !== "blob")) throw new ShareFormatError("Link to the assistant's folder on GitHub, or to its assistant.json.");
  return { kind: "github", owner, repo: r, ref, path: mode === "blob" ? fileToFolder(rest) : rest.join("/") };
}
