/**
 * The owner's profile catalogue, for the app. A copy of the pure parts of
 * lib/profile.ts: that module imports the database layer, which can't go in
 * the browser bundle. profile-catalogue.test.ts fails if the two drift.
 *
 * Also the small value helpers the wizard and Settings share: how a list,
 * a people field and goals are stored as one text value.
 */

import { athenaLinkRegex, formatAthenaLink, unescapeLabel } from "../../../lib/links";
import type { Fact, PersonRef } from "../types";

export const PROFILE_STEPS = [
  { id: "about", title: "You and your people" },
  { id: "routines", title: "Routines and taste" },
  { id: "work", title: "Work" },
  { id: "help", title: "Goals and how to help" },
] as const;
export type ProfileStepId = (typeof PROFILE_STEPS)[number]["id"];
export const PROFILE_STEP_IDS: readonly ProfileStepId[] = PROFILE_STEPS.map((s) => s.id);

export type ProfileInput = "text" | "long_text" | "choice" | "list" | "people" | "goals";

export interface ProfileField {
  key: string;
  label: string;
  input: ProfileInput;
  step: ProfileStepId;
  options?: readonly string[];
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

export function profileField(key: string): ProfileField | undefined {
  return FIELD_BY_KEY.get(key.trim().toLowerCase());
}

export interface ProfileValue {
  fact: Fact | null;
  owner_typed: boolean | null;
}

export type ProfileSectionField = Omit<ProfileField, "step"> & { step: ProfileStepId | "other" } & ProfileValue;

export interface ProfileSection {
  id: ProfileStepId | "other";
  title: string;
  fields: ProfileSectionField[];
}

/** Group current `me` facts by section, "Other" last (lib/profile.ts groupProfile). */
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

// ---------- wizard progress ----------

export const PROFILE_SETUP_VERSION = 1;

export interface ProfileSetup {
  version: number;
  step: ProfileStepId | null;
  completed_at: string | null;
  skipped: ProfileStepId[];
  /** When Athena first opened for this owner: the first week counts from it (lib/first-week.ts). */
  started_at: string | null;
}

export interface SetupChange {
  step?: ProfileStepId | null;
  skip?: ProfileStepId;
  complete?: boolean;
  restart?: boolean;
  start?: boolean;
}

export const EMPTY_SETUP: ProfileSetup = { version: PROFILE_SETUP_VERSION, step: null, completed_at: null, skipped: [], started_at: null };

/** Apply a change to the progress (lib/profile.ts applySetupChange). */
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

/** Whether Home should offer setup. */
export function setupDue(s: ProfileSetup): boolean {
  return s.completed_at === null || s.version < PROFILE_SETUP_VERSION;
}

// ---------- values ----------

/** A list value's items: comma or new line separated. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export const joinList = (items: string[]): string => items.map((i) => i.trim()).filter(Boolean).join(", ");

/** Goals: one per line, without list markers. */
export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

/** The people in a people value: its Athena links, plus any plain names typed in. */
export function parsePeople(value: string): Array<PersonRef & { linked: boolean }> {
  const out: Array<PersonRef & { linked: boolean }> = [];
  const re = athenaLinkRegex();
  for (const m of value.matchAll(re)) {
    if (m[2] !== "person") continue;
    out.push({ id: m[3].toLowerCase(), name: unescapeLabel(m[1]).replace(/^@/, ""), linked: true });
  }
  const rest = value.replace(athenaLinkRegex(), ",");
  for (const name of splitList(rest)) out.push({ id: "", name, linked: false });
  return out;
}

export function formatPeople(people: PersonRef[]): string {
  return people.map((p) => (p.id ? formatAthenaLink("person", p.id, `@${p.name}`) : p.name)).join(", ");
}

/** A value as one line of plain text for reading: links become names, lines join with " · ". */
export function displayValue(value: string, input: ProfileInput): string {
  if (input === "people") return parsePeople(value).map((p) => p.name).join(", ");
  if (input === "goals") return splitLines(value).join(" · ");
  return value.replace(athenaLinkRegex(), (_m, label: string) => unescapeLabel(label).replace(/^@/, "")).replace(/\s*\n\s*/g, " · ");
}
