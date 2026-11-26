/**
 * The words for AI models, with no DOM, so
 * they can be tested: what each job is, what a model can do and what it
 * costs in words, where a choice came from ("Same as Careful work"), which
 * models a role offers, newer and withdrawn models, search, and what taking an agreement
 * back changes.
 */
import { DEFAULT_MODELS, JOBS, PROVIDER_NAMES, PROVIDERS, sameRef, type AssistantModels, type CatalogueModel, type JobId, type ModelRef, type ModelSettings, type ProviderId, type ResolvedModel, type Tier } from "../../../lib/model-types";

/** Who a choice is for: one of the owner's four, one background job, or one assistant's thinking or pictures. */
export type Target =
  | { kind: "owner"; role: "think" | "image" | Tier }
  | { kind: "job"; job: JobId }
  | { kind: "assistant"; role: "think" | "image"; id: string; name: string; /** Its possessive pronoun: "her", "his", "their". */ their: string };

/** What a model is picked for, for what it's offered and tried as. */
export type PickRole = "think" | "image" | Tier;
export const pickRole = (t: Target): PickRole => (t.kind === "job" ? JOBS[t.job].tier : t.role);
export const testRole = (t: Target): "think" | "image" => (pickRole(t) === "image" ? "image" : "think");

export const TIERS: Record<Tier, { label: string; detail: string }> = {
  everyday: { label: "Everyday work", detail: "File summaries, memory and quick checks" },
  careful: { label: "Careful work", detail: "The briefing, drafts, recipes, setting up assistants and reading your accounts" },
};

export const JOB_WORDS: Record<JobId, { label: string; detail: string; plural?: boolean }> = {
  file_summary: { label: "File summaries", detail: "A few lines on each file you add", plural: true },
  checkin_deeper: { label: "Going deeper in check-ins", detail: "The follow-up question after Go deeper" },
  team_memory: { label: "Assistants' memory", detail: "What each assistant remembers about you" },
  team_questions: { label: "Assistants' questions", detail: "What an assistant asks you while you set it up", plural: true },
  briefing: { label: "The briefing", detail: "Your morning briefing" },
  drafts: { label: "Drafts", detail: "Replies and messages written for you to send", plural: true },
  recipes: { label: "Recipes", detail: "Reading a recipe you save and tidying it up", plural: true },
  team_draft: { label: "Setting up assistants", detail: "An assistant's first brief, from your sentence" },
  team_skill: { label: "Assistants' skills", detail: "How each assistant goes about its job", plural: true },
  skill_draft: { label: "Ask's skills", detail: "Writing a skill for Ask", plural: true },
  profile_learner: { label: "Learning about you", detail: "What Athena adds to About you" },
  collector: { label: "Reading your accounts", detail: "Collecting from the accounts you connected" },
};

export const ROLE_LABELS: Record<"think" | "image", string> = { think: "Ask thinks with", image: "Pictures" };

/** "goes" or "go", to agree with a job's name ("Drafts go", "The briefing goes"). */
export const jobVerb = (job: JobId, one: string, many: string): string => (JOB_WORDS[job].plural ? many : one);

/** "a Google model", "an OpenAI model". */
export const aOrAn = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/** The row's title and the picker's heading for a target. */
export function targetLabel(t: Target): string {
  if (t.kind === "job") return JOB_WORDS[t.job].label;
  if (t.kind === "assistant") return t.role === "think" ? `${t.name} thinks with` : `${t.name}'s pictures`;
  return t.role === "think" || t.role === "image" ? ROLE_LABELS[t.role] : TIERS[t.role].label;
}

export const companyOf = (p: ProviderId): string => PROVIDER_NAMES[p];

/** "Claude Sonnet 5.5", or the gateway's id for a model Athena has no notes on. */
export function modelName(ref: ModelRef, catalogue: readonly CatalogueModel[]): string {
  return catalogue.find((m) => sameRef(m.ref, ref))?.name ?? ref.model;
}

/** No notes of Athena's at all: shown with "Not tested with Athena". A known model may still have no one-line blurb. */
export const untested = (m: CatalogueModel): boolean => m.blurb === null && m.speed === null && m.cost === null && m.abilities.tools === "unknown";

export const SPEED: Record<NonNullable<CatalogueModel["speed"]>, string> = { quick: "Quick", balanced: "Medium speed", slow: "Takes its time" };
export const COST: Record<NonNullable<CatalogueModel["cost"]>, string> = { 1: "Lowest cost", 2: "Low cost", 3: "Medium cost", 4: "Highest cost" };

/** What it can do, in words: speed, cost, then abilities. Never colour alone. */
export function facts(m: CatalogueModel): string[] {
  const out: string[] = [];
  if (m.speed) out.push(SPEED[m.speed]);
  if (m.cost) out.push(COST[m.cost]);
  if (!m.speed && !m.cost) out.push("Speed and cost not known");
  if (m.abilities.images) out.push(changesPictures(m) ? "Makes and changes pictures" : "Makes pictures");
  else if (m.abilities.tools === true) out.push("Uses tools");
  else if (m.abilities.tools === false) out.push("Can't use tools");
  if (m.abilities.vision === true && !m.abilities.images) out.push("Sees photos");
  return out;
}

/** "Quick, lowest cost. Uses tools, sees photos.": pace, then abilities, as two short sentences for a row. */
export function factsPhrase(f: readonly string[]): string {
  const pace = new Set<string>([...Object.values(SPEED), ...Object.values(COST), "Speed and cost not known"]);
  const lower = (x: string, i: number) => (i ? x.charAt(0).toLowerCase() + x.slice(1) : x);
  return [f.filter((x) => pace.has(x)), f.filter((x) => !pace.has(x))]
    .filter((g) => g.length)
    .map((g) => `${g.map(lower).join(", ")}.`)
    .join(" ");
}

/** Changing a picture needs a Gemini model: OpenAI's edit endpoint is multipart, which the gateway refuses. */
export const changesPictures = (m: CatalogueModel): boolean => m.abilities.images && m.ref.provider === "gemini";

/** Can this model do the role at all? Models that can't think aren't offered for thinking. */
export function offeredFor(role: PickRole, m: CatalogueModel): boolean {
  if (role === "image") return m.abilities.images;
  if (m.abilities.images) return false;
  if (role === "think") return m.abilities.tools !== false;
  return true;
}

/** The code's default for a role. */
export const defaultFor = (role: PickRole): ModelRef | null => DEFAULT_MODELS[role];

/** A resolved model as GET /api/models sends it: with `newer` and `withdrawn`. */
export type Resolved = ResolvedModel & { newer?: ModelRef; withdrawn?: ModelRef };

/** "A newer version is out: Claude Sonnet 5.5". The choice stays until the owner switches. */
export function newerWords(r: Resolved | null | undefined, catalogue: readonly CatalogueModel[]): string | null {
  return r?.newer ? `A newer version is out: ${modelName(r.newer, catalogue)}` : null;
}

/** The chosen model is no longer offered: "No longer offered, using Claude Haiku 5.5". Pictures have nothing else to run. */
export function withdrawnWords(role: PickRole, r: Resolved | null | undefined, catalogue: readonly CatalogueModel[]): string | null {
  if (!r?.withdrawn) return null;
  if (role === "image" || sameRef(r.withdrawn, r.ref)) return "No longer offered. Pictures are off until you pick another.";
  return `No longer offered, using ${modelName(r.ref, catalogue)}`;
}

/** What a row names: the model chosen, even when it's gone (its note says what runs instead). */
export const shownRef = (r: Resolved): ModelRef => r.withdrawn ?? r.ref;

/** A row's note and its one action: switch to the newer version, or pick another for one that's gone. Gone wins. `name` ends `text`, so it can be kept on one line. */
export type RowNote = { kind: "gone"; text: string; name: string | null; action: "Pick another" } | { kind: "newer"; text: string; name: string; action: "Switch"; label: string; ref: ModelRef };

export function rowNote(role: PickRole, r: Resolved | null | undefined, catalogue: readonly CatalogueModel[], opts: { follows?: boolean } = {}): RowNote | null {
  // A job that only follows its tier says nothing: the note, and the switch, belong to the tier's row.
  if (opts.follows) return null;
  const gone = withdrawnWords(role, r, catalogue);
  if (gone) return { kind: "gone", text: gone, name: gone.startsWith("No longer offered, using ") ? modelName(r!.ref, catalogue) : null, action: "Pick another" };
  if (!r?.newer) return null;
  const name = modelName(r.newer, catalogue);
  return { kind: "newer", text: newerWords(r, catalogue)!, name, action: "Switch", label: `Switch to ${name}`, ref: r.newer };
}

/** A note's words with the model's name split off the end: ["A newer version is out: ", "Claude Sonnet 5.5"]. */
export const notePieces = (n: RowNote): [string, string] => (n.name && n.text.endsWith(n.name) ? [n.text.slice(0, -n.name.length), n.name] : [n.text, ""]);

/** Every model the role offers, by company in the gateway's order, keeping the catalogue's order within each (newest first). */
export function byCompany(models: readonly CatalogueModel[]): Array<{ provider: ProviderId; models: CatalogueModel[] }> {
  return PROVIDERS.map((provider) => ({ provider, models: models.filter((m) => m.ref.provider === provider) })).filter((g) => g.models.length);
}

// ---------- search ----------

const SYNONYMS: Array<[RegExp, (m: CatalogueModel) => boolean]> = [
  [/^(cheap|cheapest|low|budget)/, (m) => (m.cost ?? 9) <= 2],
  [/^(quick|fast|speed)/, (m) => m.speed === "quick"],
  [/^(photo|vision|see)/, (m) => m.abilities.vision === true],
  [/^(picture|image|draw)/, (m) => m.abilities.images],
  [/^(tool)/, (m) => m.abilities.tools === true],
  [/^(untested|unknown)/, (m) => untested(m)],
];

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** How well one model matches the words typed: 0 for no match. Every word must match something. */
export function matchScore(m: CatalogueModel, query: string): number {
  const words = fold(query).split(/[\s/]+/).filter(Boolean);
  if (!words.length) return 1;
  const name = fold(m.name);
  const id = fold(m.ref.model);
  const company = fold(companyOf(m.ref.provider));
  const blurb = fold(m.blurb ?? "");
  let score = 0;
  for (const w of words) {
    let best = 0;
    if (name.startsWith(w)) best = 100;
    else if (name.split(/[\s.-]+/).some((p) => p.startsWith(w))) best = 80;
    else if (company.startsWith(w) || m.ref.provider.startsWith(w)) best = 60;
    else if (id.includes(w) || name.replace(/\s+/g, "-").includes(w) || name.replace(/\s+/g, "").includes(w.replace(/-/g, ""))) best = 50;
    else if (blurb.includes(w)) best = 20;
    else if (SYNONYMS.some(([re, ok]) => re.test(w) && ok(m))) best = 15;
    if (!best) return 0;
    score += best;
  }
  // Known models a little above the gateway's unknowns at the same strength.
  return score + (untested(m) ? 0 : 5);
}

/** The models matching a search, best first, keeping the catalogue's order for ties. */
export function searchModels<T extends CatalogueModel>(models: readonly T[], query: string): T[] {
  if (!query.trim()) return [...models];
  return models
    .map((m, i) => ({ m, i, s: matchScore(m, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

// ---------- where a choice came from ----------

/** "Same as Careful work", "Your choice", …: why a row runs what it runs. */
export function whyWords(t: Target, r: Resolved | null): string {
  // A chosen model that's gone is still the owner's choice: `from` then says where what runs instead came from.
  const chosen = !!r?.withdrawn;
  if (t.kind === "assistant") return chosen || r?.from === "assistant" ? `${t.their.charAt(0).toUpperCase()}${t.their.slice(1)} own` : "Same as Ask";
  if (!r) return "Pick a model to turn them on";
  if (chosen) return t.kind === "job" ? "Its own model" : "Your choice";
  if (r.from === "env") return "Set for this site";
  if (t.kind === "job") return r.from === "job" || r.from === "owner" ? "Its own model" : `Same as ${TIERS[JOBS[t.job].tier].label}`;
  return r.from === "default" ? "Athena's default" : "Your choice";
}

/** The "same as" option at the top of a picker, if the target has one: what choosing nothing means. */
export function followWords(t: Target, inherited: string | null): { label: string; detail: string } | null {
  if (t.kind === "job") return { label: `Same as ${TIERS[JOBS[t.job].tier].label}`, detail: inherited ?? "" };
  if (t.kind === "assistant") return { label: "Same as Ask", detail: inherited ?? "Off" };
  if (t.role === "image") return { label: "Off", detail: "No pictures in Ask or assistant chats" };
  return null;
}

/** "Sol thinks with Gemini 3.5 Flash now", for the polite live region after a save. */
export function savedWords(t: Target, name: string | null, none = false): string {
  if (t.kind === "assistant") {
    if (t.role === "think") return name ? `${t.name} thinks with ${name} now` : `${t.name} thinks with the same model as Ask now`;
    if (none) return `${t.name} won't make pictures`;
    return name ? `${t.name} makes pictures with ${name} now` : `${t.name}'s pictures are the same as Ask's now`;
  }
  if (t.kind === "job") return name ? `${JOB_WORDS[t.job].label} ${jobVerb(t.job, "uses", "use")} ${name} now` : `${JOB_WORDS[t.job].label} ${jobVerb(t.job, "follows", "follow")} ${TIERS[JOBS[t.job].tier].label} again`;
  if (t.role === "think") return `Ask thinks with ${name ?? "Athena's default"} now`;
  if (t.role === "image") return name ? `Pictures use ${name} now` : "Pictures are off";
  return `${TIERS[t.role].label} uses ${name ?? "Athena's default"} now`;
}

// ---------- agreements ----------

/** Every choice on a company, the owner's and each assistant's, as it would read once that agreement is taken back. */
export function takeBackEffects(provider: ProviderId, settings: ModelSettings, assistants: ReadonlyArray<{ name: string; models: AssistantModels }>, catalogue: readonly CatalogueModel[]): string[] {
  const out: string[] = [];
  const on = (r: ModelRef | null | undefined) => r?.provider === provider;
  const name = (r: ModelRef | null) => (r ? modelName(r, catalogue) : null);
  if (on(settings.think)) out.push(`Ask goes back to ${name(DEFAULT_MODELS.think)}`);
  if (on(settings.image)) out.push("Pictures turn off");
  for (const tier of ["everyday", "careful"] as const) if (on(settings[tier])) out.push(`${TIERS[tier].label} goes back to ${name(DEFAULT_MODELS[tier])}`);
  for (const job of Object.keys(JOBS) as JobId[]) if (on(settings.jobs?.[job])) out.push(`${JOB_WORDS[job].label} ${jobVerb(job, "goes", "go")} back to the same as ${TIERS[JOBS[job].tier].label}`);
  for (const a of assistants) {
    const think = on(a.models.think);
    const image = on(a.models.image);
    if (think && image) out.push(`${a.name}'s thinking and pictures go back to the same as Ask`);
    else if (think) out.push(`${a.name}'s thinking goes back to the same as Ask`);
    else if (image) out.push(`${a.name}'s pictures go back to the same as Ask`);
  }
  return out;
}

/** "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "0.8 seconds", "1 second", "12 seconds". */
export function seconds(ms: number): string {
  const s = ms < 10_000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000);
  return `${s} ${s === 1 ? "second" : "seconds"}`;
}

/** "Agreed 14 Nov", for an agreement's row. */
export function agreedWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const same = d.getFullYear() === now.getFullYear();
  return `Agreed ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(same ? {} : { year: "numeric" }) }).format(d)}`;
}
