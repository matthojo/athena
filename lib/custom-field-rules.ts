/**
 * Custom fields: the owner's own details on any kind of record ("Shoe size"
 * and "Interests" on people, "Rating" on Watch & read), defined in
 * Settings or through Ask rather than built in.
 *
 * Pure and shared: the server (lib/custom-fields.ts), Ask's assistant, the
 * MCP server and the PWA all read the kinds, the types, what a value may be,
 * how it reads and which type changes are safe from here, so they agree.
 */

import { isValidDate } from "./dates";
import { KIND_WORD } from "./custom-kind-words";

// ---------- kinds ----------

export interface FieldKindInfo {
  /** The Settings tab: "People". */
  label: string;
  /** One record, for sentences: "person", "reading item". */
  one: string;
  /** All of them, for sentences: "people", "Watch & read". */
  many: string;
  /** Server only: the kind's table and its display-title column. */
  table: string;
  title: string;
}

/**
 * Every kind of record a field can belong to, in Settings order. A new kind
 * (trips, purchases) is one line here: the database takes any kind, and
 * Settings, Ask and MCP read this list. Its own screen then shows the fields
 * with customFieldsSection() (app/src/components/custom-fields.ts).
 */
export const FIELD_KINDS = {
  person: { label: "People", one: "person", many: "people", table: "people", title: "name" },
  place: { label: "Places", one: "place", many: "places", table: "places", title: "name" },
  organisation: { label: "Organisations", one: "organisation", many: "organisations", table: "organisations", title: "name" },
  event: { label: "Events", one: "event", many: "events", table: "events", title: "title" },
  note: { label: "Notes", one: "note", many: "notes", table: "notes", title: "title" },
  reading: { label: "Watch & read", one: "item", many: "Watch & read", table: "reading_items", title: "title" },
  goal: { label: "Goals", one: "goal", many: "goals", table: "goals", title: "title" },
  asset: { label: "Life admin", one: "life admin item", many: "life admin", table: "assets", title: "name" },
  project: { label: "Projects", one: "project", many: "projects", table: "projects", title: "name" },
} as const satisfies Record<string, FieldKindInfo>;

/** A kind Athena has built in: 'person', 'reading', … */
export type BuiltinFieldKind = keyof typeof FIELD_KINDS;
/** One of the owner's own kinds of record ("Wines"): 'custom:<kind id>' (lib/custom-kinds.ts). */
export type CustomFieldKind = `custom:${string}`;
export type FieldKind = BuiltinFieldKind | CustomFieldKind;
/** The built-in kinds, in Settings order. The owner's own kinds follow them, in their own order. */
export const FIELD_KIND_LIST = Object.keys(FIELD_KINDS) as BuiltinFieldKind[];

const CUSTOM_KIND = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBuiltinKind(value: unknown): value is BuiltinFieldKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FIELD_KINDS, value);
}

/** 'custom:<uuid>'. Whether that kind exists (and is live) is the server's to say. */
export function isCustomKind(value: unknown): value is CustomFieldKind {
  return typeof value === "string" && CUSTOM_KIND.test(value);
}

export function isFieldKind(value: unknown): value is FieldKind {
  return isBuiltinKind(value) || isCustomKind(value);
}

/** A custom kind's id as its field kind, and back. */
export const customKindKey = (id: string): CustomFieldKind => `custom:${id.toLowerCase()}`;
export const customKindId = (kind: CustomFieldKind): string => kind.slice("custom:".length).toLowerCase();

/** What a custom kind is called: enough to word a sentence about it. */
export interface CustomKindNames {
  id: string;
  /** "Wines": as shown. */
  name: string;
  /** "wine": one record, mid-sentence. */
  one: string;
}

/** The owner's own kinds, by field kind, as this process last learned them (registerCustomKinds). */
const customKinds = new Map<string, FieldKindInfo>();

export function customKindInfo(k: CustomKindNames): FieldKindInfo {
  return { label: k.name, one: k.one, many: inSentence(k.name), table: "custom_records", title: "title" };
}

/**
 * Teach fieldKindInfo() the owner's own kinds' names. The server registers
 * them as it reads them (lib/custom-fields.ts kindInfo), the PWA whenever it
 * loads them (app/src/db/custom-kinds.ts). `replace` forgets the rest.
 */
export function registerCustomKinds(kinds: CustomKindNames[], opts: { replace?: boolean } = {}): void {
  if (opts.replace) customKinds.clear();
  for (const k of kinds) customKinds.set(customKindKey(k.id), customKindInfo(k));
}

/**
 * What Athena knows about a kind. Everything reads kinds through this and
 * isFieldKind(), and stores them as plain strings, so the owner's own kinds
 * ('custom:<uuid>', lib/custom-kinds.ts) use the same fields, values, Settings
 * list and editors as the built-in ones. A custom kind reads from the names
 * registered above; on the server, lib/custom-fields.ts kindInfo() reads the
 * database first.
 */
export function fieldKindInfo(kind: FieldKind): FieldKindInfo {
  if (isBuiltinKind(kind)) return FIELD_KINDS[kind];
  return customKinds.get(kind.toLowerCase()) ?? { label: KIND_WORD.One, one: "item", many: "items", table: "custom_records", title: "title" };
}

// ---------- the owner's own kinds: names and icons ----------

export const KIND_LIMITS = { name: 40, kinds: 50, title: 300, body: 100_000 } as const;

/**
 * The icons a kind can have: the app's own line icons (app/src/components/icons.ts),
 * stored by name. The first is what a new kind gets.
 */
export const KIND_ICONS = [
  "folder",
  "wine",
  "leaf",
  "dice",
  "cup",
  "book",
  "film",
  "music",
  "game",
  "bookmark",
  "star",
  "heart",
  "gift",
  "tag",
  "pin",
  "plane",
  "suitcase",
  "ticket",
  "car",
  "paw",
  "parcel",
  "target",
  "flag",
  "sparkle",
  "briefcase",
  "people",
] as const;
export type KindIcon = (typeof KIND_ICONS)[number];

export function isKindIcon(value: unknown): value is KindIcon {
  return typeof value === "string" && (KIND_ICONS as readonly string[]).includes(value);
}

const refusedKind = (name: string) =>
  new FieldError(`“${name}” sounds like a bank, card, password or medical detail. ${upperFirst(KIND_WORD.many)} aren't for those: they need stronger protection.`);

/** "wines" -> "Wines": a kind's name, as the Library will show it. */
export function cleanKindName(raw: unknown): string {
  if (typeof raw !== "string" || !tidy(raw)) throw new FieldError(`Give the ${KIND_WORD.one} a name, like Wines or Plants`);
  const name = upperFirst(tidy(raw));
  if (name.length > KIND_LIMITS.name) throw new FieldError(`Keep the name under ${KIND_LIMITS.name} characters`);
  if (sensitiveLabel(name)) throw refusedKind(name);
  return name;
}

/**
 * One of a kind, from its name: "Wines" -> "wine", "Board games" -> "board
 * game", "Berries" -> "berry", "Boxes" -> "box". A name that isn't a plain
 * plural stays as it is ("Sheet music").
 */
export function singular(name: string): string {
  const words = tidy(name).split(" ");
  const last = words.pop() ?? "";
  let one = last;
  const irregular: Record<string, string> = { people: "person", children: "child", series: "series", species: "species", movies: "movie", cookies: "cookie" };
  if (irregular[last.toLowerCase()]) one = irregular[last.toLowerCase()];
  else if (/[^aeiou]ies$/i.test(last) && last.length > 4) one = `${last.slice(0, -3)}y`;
  else if (/(ss|sh|ch|x|z)es$/i.test(last)) one = last.slice(0, -2);
  else if (/[^s]s$/i.test(last) && !/(us|is)$/i.test(last)) one = last.slice(0, -1);
  return inSentence([...words, one].join(" "));
}

/** One record of a kind, for sentences and buttons ("New wine"): given, or worked out from the name. */
export function cleanKindOne(raw: unknown, name: string): string {
  const given = typeof raw === "string" && tidy(raw) ? tidy(raw) : singular(name);
  const one = inSentence(given);
  if (one.length > KIND_LIMITS.name) throw new FieldError(`Keep the name for one under ${KIND_LIMITS.name} characters`);
  if (sensitiveLabel(one)) throw refusedKind(one);
  return one;
}

/** A record's title: trimmed, one line, not empty. */
export function cleanRecordTitle(raw: unknown, one = "item"): string {
  if (typeof raw !== "string" || !tidy(raw)) throw new FieldError(`Give the ${one} a name`);
  const title = tidy(raw);
  if (title.length > KIND_LIMITS.title) throw new FieldError(`Keep the name under ${KIND_LIMITS.title} characters`);
  return title;
}

/** "Wines copy", then "Wines copy 2", … as long as `taken` says a name is in use; kept to the name limit. */
export function copyName(name: string, taken: (candidate: string) => boolean): string {
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    const candidate = `${name.slice(0, KIND_LIMITS.name - suffix.length).trimEnd()}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `${name.slice(0, KIND_LIMITS.name - 5).trimEnd()} copy`;
}

// ---------- types ----------

export const FIELD_TYPES = ["text", "long_text", "number", "rating", "boolean", "date", "link", "choice", "choices"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_INFO: Record<FieldType, { label: string; hint: string }> = {
  text: { label: "Text", hint: "A word or a line" },
  long_text: { label: "Long text", hint: "A few sentences" },
  number: { label: "Number", hint: "Like a shoe size" },
  rating: { label: "Rating", hint: "One to five stars" },
  boolean: { label: "Yes/No", hint: "Just yes or no" },
  date: { label: "Date", hint: "A day" },
  link: { label: "Link", hint: "A web address" },
  choice: { label: "Choice", hint: "One from a list" },
  choices: { label: "Choices", hint: "Several, like tags" },
};

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}

/** Types that pick from a list of options. */
export const hasOptions = (type: FieldType) => type === "choice" || type === "choices";

/** A value: text, a number, true/false, or (choices) a list. */
export type FieldValue = string | number | boolean | string[];

export interface CustomField {
  id: string;
  kind: FieldKind;
  label: string;
  type: FieldType;
  /** choice / choices: the list to pick from, in order. */
  options: string[];
  /** number: "UK", "cm"; "" for none. */
  unit: string;
  position: number;
  /** How many records have a value (archived records included). */
  value_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomValue {
  field_id: string;
  entity_kind: FieldKind;
  entity_id: string;
  value: FieldValue;
  updated_at: string;
}

export const LIMITS = { label: 60, option: 60, options: 60, unit: 12, text: 300, longText: 5000, link: 2000, choices: 30 } as const;

/** A value the owner or an agent gave that doesn't fit the field: the message is for the owner. */
export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldError";
  }
}

// ---------- labels ----------

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "shoe size" -> "Shoe size"; capitals the owner typed stay ("UK size"). */
export function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string" || !tidy(raw)) throw new FieldError("Give the field a name");
  const label = upperFirst(tidy(raw));
  if (label.length > LIMITS.label) throw new FieldError(`Keep the name under ${LIMITS.label} characters`);
  if (sensitiveLabel(label)) {
    throw new FieldError(`“${label}” sounds like a bank, card, password or medical detail. Fields aren't for those: they need stronger protection.`);
  }
  return label;
}

/** For matching names: case, punctuation and a plural "s" don't matter ("interests" finds "Interests"). */
export function labelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/(\w{3,})s$/, "$1");
}

export const sameLabel = (a: string, b: string) => labelKey(a) === labelKey(b);

/**
 * Finance and health content has its own, stronger protection (docs:
 * security/encryption), so fields don't become a way around it: a field can't be named for a
 * bank, card, password or medical detail.
 */
const SENSITIVE =
  /\b(passwords?|passcodes?|pins?|pin (number|code)|cvv|cvc|card (numbers?|no|details)|bank (details|account|accounts|balance)|account (numbers?|no)|sort codes?|iban|swift code|salary|salaries|income|net worth|credit score|national insurance|ni number|nhs number|passport number|policy number|licence number|diagnosis|diagnoses|medications?|prescriptions?|medical (conditions?|history|details)|blood (type|group))\b/i;

export function sensitiveLabel(label: string): boolean {
  return SENSITIVE.test(label);
}

/** "Shoe size" → "shoe size", for use mid-sentence. Leaves "NHS number" and "iPhone model" alone. */
function inSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** "Add shoe size" — the empty-field prompt, in the same style as the built-in fields. */
export function placeholderFor(label: string): string {
  return `Add ${inSentence(label)}`;
}

/**
 * The one row that stands for a record's empty fields: "Add shoe size and
 * interests", "Add shoe size, clothing size and interests", and past three,
 * "Add shoe size, clothing size and 2 more".
 */
export function addFieldsPrompt(labels: string[]): string {
  const names = labels.map(inSentence);
  if (names.length <= 1) return `Add ${names[0] ?? "a detail"}`;
  if (names.length <= 3) return `Add ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Add ${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

// ---------- options and units ----------

/** Option names: trimmed, no blanks, no repeats (ignoring case), kept in order. */
export function cleanOptions(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new FieldError("Options should be a list");
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const option = tidy(item);
    if (!option) continue;
    if (option.length > LIMITS.option) throw new FieldError(`Keep each option under ${LIMITS.option} characters`);
    if (!out.some((o) => o.toLowerCase() === option.toLowerCase())) out.push(option);
  }
  if (out.length > LIMITS.options) throw new FieldError(`A field can have up to ${LIMITS.options} options`);
  return out;
}

export function cleanUnit(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new FieldError("The unit should be text, like UK or cm");
  const unit = tidy(raw);
  if (unit.length > LIMITS.unit) throw new FieldError(`Keep the unit under ${LIMITS.unit} characters`);
  return unit;
}

// ---------- values ----------

type FieldShape = Pick<CustomField, "label" | "type" | "options" | "unit">;

const CURRENCY = /^[£$€¥₹]$/;
const NUMBER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A number as it reads with its unit: "6 UK", "180 cm", "£45". */
export function numberWithUnit(n: number, unit: string): string {
  const text = NUMBER.format(n);
  if (!unit) return text;
  return CURRENCY.test(unit) ? `${unit}${text}` : `${text} ${unit}`;
}

/** A web link as typed, with https:// added when it had no scheme; null when it isn't one. */
export function linkHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? withScheme : null;
  } catch {
    return null;
  }
}

const isEmpty = (raw: unknown) => raw === null || raw === undefined || (typeof raw === "string" && !raw.trim()) || (Array.isArray(raw) && raw.length === 0);

/** An option the owner typed in lower case reads better capitalised ("jazz" -> "Jazz"); "iOS" stays. */
const optionCase = (s: string) => (s === s.toLowerCase() ? upperFirst(s) : s);

export interface Normalised {
  /** null = clear the value. */
  value: FieldValue | null;
  /** choices: new options this value brings, to add to the field. */
  newOptions: string[];
}

/**
 * Check and tidy a value for a field. Empty (null, "", []) means clear it.
 * Lenient about form ("6", "UK 6", "5 stars", "yes", "Climbing, jazz"),
 * strict about meaning: a rating is ½–5 stars, a choice is one of the options.
 */
export function normaliseValue(field: FieldShape, raw: unknown): Normalised {
  const none: Normalised = { value: null, newOptions: [] };
  if (isEmpty(raw)) return none;
  const { label } = field;
  switch (field.type) {
    case "text":
    case "long_text": {
      if (typeof raw !== "string" && typeof raw !== "number") throw new FieldError(`${label} takes text`);
      const long = field.type === "long_text";
      const text = long ? String(raw).replace(/\r\n?/g, "\n").trim() : tidy(String(raw));
      const max = long ? LIMITS.longText : LIMITS.text;
      if (text.length > max) throw new FieldError(`Keep ${label.toLowerCase()} under ${max.toLocaleString("en-GB")} characters`);
      return { value: text, newOptions: [] };
    }
    case "number": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string") {
        let s = raw.trim();
        if (field.unit) s = s.replace(new RegExp(field.unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
        s = s.replace(/,/g, "").trim();
        n = /^[-+]?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
      } else n = NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new FieldError(`${label} takes a number`);
      return { value: n, newOptions: [] };
    }
    case "rating": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string") {
        const s = raw.trim();
        // "★★★★½" (Letterboxd's half star), "4.5", "4.5/5", "4 stars".
        const stars = (s.match(/★/g) ?? []).length + (/½/.test(s) ? 0.5 : 0);
        const m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*5|out of 5|of 5|stars?)?$/i.exec(s);
        n = stars ? stars : m ? Number(m[1]) : NaN;
      } else n = NaN;
      if (n === 0) return none;
      // Whole or half stars: 0.5 to 5.
      if (!Number.isInteger(n * 2) || n < 0.5 || n > 5) throw new FieldError(`${label} goes from half a star to 5 stars`);
      return { value: n, newOptions: [] };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw, newOptions: [] };
      const s = String(raw).trim().toLowerCase();
      if (["yes", "y", "true", "1"].includes(s)) return { value: true, newOptions: [] };
      if (["no", "n", "false", "0"].includes(s)) return { value: false, newOptions: [] };
      throw new FieldError(`${label} is yes or no`);
    }
    case "date": {
      const s = typeof raw === "string" ? raw.trim().slice(0, 10) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !isValidDate(s)) throw new FieldError(`${label} takes a date (YYYY-MM-DD)`);
      return { value: s, newOptions: [] };
    }
    case "link": {
      const href = typeof raw === "string" ? linkHref(raw) : null;
      if (!href) throw new FieldError(`${label} takes a web address, like example.com`);
      if (href.length > LIMITS.link) throw new FieldError(`That link is too long for ${label.toLowerCase()}`);
      return { value: href, newOptions: [] };
    }
    case "choice": {
      if (typeof raw !== "string") throw new FieldError(`${label} takes one of its options`);
      const wanted = tidy(raw).toLowerCase();
      const match = field.options.find((o) => o.toLowerCase() === wanted);
      if (!match) {
        const list = field.options.length ? `${label} is one of: ${field.options.join(", ")}.` : `${label} has no options yet.`;
        throw new FieldError(`${list} Add “${tidy(raw)}” to its options in Settings first.`);
      }
      return { value: match, newOptions: [] };
    }
    case "choices": {
      const items = typeof raw === "string" ? raw.split(/[,;\n]/) : Array.isArray(raw) ? raw : null;
      if (!items) throw new FieldError(`${label} takes a list`);
      const value: string[] = [];
      const newOptions: string[] = [];
      for (const item of items) {
        if (typeof item !== "string") continue;
        const s = tidy(item);
        if (!s) continue;
        if (s.length > LIMITS.option) throw new FieldError(`Keep each of ${label.toLowerCase()} under ${LIMITS.option} characters`);
        const canonical = field.options.find((o) => o.toLowerCase() === s.toLowerCase()) ?? newOptions.find((o) => o.toLowerCase() === s.toLowerCase()) ?? optionCase(s);
        if (!field.options.includes(canonical) && !newOptions.includes(canonical)) newOptions.push(canonical);
        if (!value.includes(canonical)) value.push(canonical);
      }
      if (!value.length) return none;
      if (value.length > LIMITS.choices) throw new FieldError(`${label} can hold up to ${LIMITS.choices}`);
      if (field.options.length + newOptions.length > LIMITS.options) throw new FieldError(`${label} has too many options. Tidy them up in Settings first.`);
      return { value, newOptions };
    }
  }
}

/** A stored value of the right shape for its field's type (what came back from the database). */
export function isValueOfType(type: FieldType, value: unknown): value is FieldValue {
  switch (type) {
    case "number":
    case "rating":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "choices":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    default:
      return typeof value === "string";
  }
}

/** How a value reads in a sentence: "6 UK", "4 stars", "4½ stars", "Yes", "4 Mar 2026", "Climbing, Jazz". */
export function formatValue(field: Pick<CustomField, "type" | "unit">, value: FieldValue): string {
  switch (field.type) {
    case "number":
      return typeof value === "number" ? numberWithUnit(value, field.unit) : String(value);
    case "rating":
      return starWords(Number(value));
    case "boolean":
      return value ? "Yes" : "No";
    case "date":
      return typeof value === "string" && isValidDate(value) ? DATE.format(new Date(`${value}T12:00:00Z`)) : String(value);
    case "link":
      return String(value).replace(/^https?:\/\//, "").replace(/\/$/, "");
    case "choices":
      return Array.isArray(value) ? value.join(", ") : String(value);
    default:
      return String(value);
  }
}

/** A kind's Rating: the live rating field called "Rating", else its first live rating field. Watch & read's stars (lib/watch-read-sync.ts). */
export function ratingFieldOf<F extends Pick<CustomField, "kind" | "type" | "label" | "archived_at">>(fields: F[], kind: FieldKind): F | undefined {
  const mine = fields.filter((f) => f.kind === kind && f.type === "rating" && !f.archived_at);
  return mine.find((f) => sameLabel(f.label, "Rating")) ?? mine[0];
}

/** "1 star", "4 stars", "4½ stars", "Half a star". */
export function starWords(n: number): string {
  if (n === 0.5) return "Half a star";
  const whole = Math.floor(n);
  const half = n - whole >= 0.5 ? "½" : "";
  return `${whole}${half} ${n === 1 ? "star" : "stars"}`;
}

/** The words a search can match (text, long text and choices); "" for the rest. */
export function searchText(type: FieldType, value: FieldValue): string {
  switch (type) {
    case "text":
    case "long_text":
    case "choice":
      return typeof value === "string" ? value : "";
    case "choices":
      return Array.isArray(value) ? value.join(" ") : "";
    default:
      return "";
  }
}

// ---------- changing a field's type ----------

/**
 * The type changes that keep every value as it is (or turn it into the same
 * thing in the new type). Anything else is only allowed while no record has
 * a value; otherwise make a new field.
 */
export const SAFE_TYPE_CHANGES: Record<FieldType, FieldType[]> = {
  text: ["long_text"],
  long_text: [],
  number: ["text", "long_text"],
  rating: ["number"],
  boolean: [],
  date: [],
  link: ["text", "long_text"],
  choice: ["choices", "text", "long_text"],
  choices: [],
};

export function typeChangeAllowed(from: FieldType, to: FieldType, hasValues: boolean): boolean {
  return from === to || !hasValues || SAFE_TYPE_CHANGES[from].includes(to);
}

const AS_TYPE: Record<FieldType, string> = {
  text: "text",
  long_text: "long text",
  number: "a number",
  rating: "a rating",
  boolean: "a yes or no",
  date: "a date",
  link: "a link",
  choice: "a choice from a list",
  choices: "a list of choices",
};

/** Why a type change isn't allowed, in the owner's words. */
export function typeChangeRefusal(label: string, to: FieldType): string {
  return `${label} already has values that wouldn't work as ${AS_TYPE[to]}. Add a new field instead, and archive this one when you're ready.`;
}

/** A stored value carried across an allowed type change. */
export function convertValue(from: FieldType, to: FieldType, value: FieldValue): FieldValue {
  if (from === to) return value;
  if (to === "choices") return Array.isArray(value) ? value : [String(value)];
  if (to === "text" || to === "long_text") return Array.isArray(value) ? value.join(", ") : String(value);
  return value;
}
