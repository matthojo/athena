/**
 * The Add screen's words (app/src/add/view.ts): where an item came from, what it can reach, what it needs, and what
 * happens once it's added. Pure, so the tests can read the words without a DOM. Athena's words throughout, never
 * the file's: a file only supplies its name, summary, questions and content, each shown as its author's.
 */
import type { AddPreview } from "../../../lib/community-api";
import { LOOKUP_TOOLS } from "../../../lib/reach";
import { listingIdOf } from "../../../lib/community-site";
import { downloadWords, tierWords } from "../community/words";
import type { Reach } from "../../../lib/reach";
import type { ShareKind } from "../../../lib/share-kinds";
import { ownMirror, type CheckinKind, type QuestionType } from "../../../lib/checkin-types";
import { FLOW_DRAFT_TOOLS, FLOW_LOOK_TOOLS, FLOW_SHARE_TOOLS, type FlowPick, type SharedFlowStep } from "../../../lib/flow-share";

export const KIND_LABEL: Record<ShareKind, string> = { assistant: "Assistant", skill: "Skill", flow: "Flow", checkin: "Check-in questions", template: "Template", theme: "Theme" };

/** "From Community", with how often it was downloaded when the catalogue says; or "Not from Community" with where it did come from. */
export function originWords(p: Pick<AddPreview, "from" | "listing">): { community: boolean; title: string; detail: string } {
  if ("catalogue" in p.from) {
    const reviewed = p.listing?.featured ? "Reviewed and featured in the catalogue" : "Reviewed for the catalogue";
    const downloads = downloadWords(p.listing?.downloads);
    return { community: true, title: "From Community", detail: downloads ? `${reviewed} · ${downloads}` : reviewed };
  }
  if ("link" in p.from) return { community: false, title: "Not from Community", detail: linkWords(p.from.link) };
  return { community: false, title: "Not from Community", detail: p.from.files ? `From ${p.from.files}` : "From a file" };
}

/** "From github.com/sample-author/athena-items". */
export function linkWords(link: string): string {
  try {
    const u = new URL(link);
    const parts = u.pathname.split("/").filter(Boolean);
    return `From ${u.hostname.replace(/^www\./, "")}${parts.length ? `/${parts.slice(0, 2).join("/")}` : ""}`;
  } catch {
    return "From a link";
  }
}

/** "By @sample-author · version 1.2.0": who made it, as the file says. Empty when it doesn't say. */
export function makerWords(header: AddPreview["header"]): string {
  const parts: string[] = [];
  if (header.author) parts.push(`By @${header.author}`);
  if (header.version) parts.push(`version ${header.version}`);
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}

/** "Based on github.com/…", or "Based on a Community listing", when it says it was made from another item. */
export const basedOnWords = (header: AddPreview["header"]): string => (!header.based_on ? "" : listingIdOf(header.based_on) ? "Based on a Community listing" : `Based on ${header.based_on.replace(/^https:\/\/(www\.)?/, "")}`);

const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Its reach in plain words: the tier's name, as Community and the share sheet name it, and a line for each thing it uses. */
export function reachWords(r: Reach, kind: ShareKind): { title: string; lines: string[] } {
  const lines: string[] = [];
  if (kind === "checkin") return { title: tierWords(r), lines: ["Its questions stay in your Athena, and so do your answers"] };
  if (kind === "template") return { title: tierWords(r), lines: ["Its fields fill in from your own records, inside your Athena. Nothing in it loads anything by itself"] };
  if (kind === "theme") return { title: tierWords(r), lines: ["It only changes how Athena looks: colours, corners, spacing and text size. It has no fonts or pictures, and nothing in it loads anything"] };
  if (r.tier === 1) return { title: tierWords(r), lines: ["Every step stays inside your Athena. Nothing is sent anywhere"] };
  if (r.model) lines.push(kind === "flow" ? "Some of its steps send what they work on to the AI model you chose" : "It sends what it works on to the AI model you chose");
  for (const tool of r.lookups) {
    const l = LOOKUP_TOOLS[tool];
    lines.push(l ? `${l.label}, from ${l.service}` : "It looks something up outside Athena");
  }
  if (r.web) lines.push("It asks to search the web and read the pages it finds. That stays off until you allow it");
  return { title: tierWords(r), lines };
}

/** The confirmation once it's added: its headline, what to do next, and where it now lives. */
export function addedWords(kind: ShareKind, name: string): { title: string; body: string; open: string } {
  if (kind === "assistant") return { title: `${name} joined your team, paused`, body: "Nothing runs until you switch it on from its page. Its accounts and what it may do alone are there too.", open: `Open ${name}` };
  if (kind === "skill") return { title: `${name} is in your skills, off`, body: "Ask won't use it until you switch it on from its page.", open: "Open the skill" };
  if (kind === "template") return templateAddedWords(name, { name, renamed: false });
  if (kind === "theme") return themeAddedWords(name, { name, renamed: false, used: false });
  return { title: `${name} is in your flows, off`, body: "It won't run until you switch it on. You can try it first from its page.", open: "Open the flow" };
}

const NOUN: Record<ShareKind, string> = { assistant: "assistant", skill: "skill", flow: "flow", checkin: "check-in questions", template: "template", theme: "theme" };

/** "You already have this": what's here, which version, and the button that opens it. */
export function haveWords(kind: ShareKind, had: NonNullable<AddPreview["existing"]>, listed: string | null): { title: string; detail: string; open: string } {
  const open = kind === "assistant" ? "Open yours" : kind === "checkin" ? "Open check-in settings" : `Open your ${NOUN[kind]}`;
  if (!had.newer) return { title: "You already have this", detail: had.version ? `You added version ${had.version}, the same as this one.` : "You added it from Community, and it hasn't changed since.", open };
  const yours = had.version ? `You have version ${had.version}` : "You have an earlier version";
  if ((kind === "template" || kind === "theme") && had.changed) return { title: "You already have this", detail: `${yours}, and you've changed it since. ${listed ? `Version ${listed}` : "The new version"} can go beside it, and yours stays as you left it.`, open };
  return { title: "You already have this", detail: `${yours}. ${listed ? `This is version ${listed}` : "This one is newer"}: look it over, then update yours.`, open };
}

/** The confirmation once an Update is done. */
export function updatedWords(kind: ShareKind, name: string, beside = false): { title: string; body: string; open: string } {
  if (kind === "template" && beside) return { title: `The new ${name} is beside yours`, body: "Yours stays as you left it and no longer gets updates. The new one is in your templates too.", open: "Open the new one" };
  if (kind === "template") return { title: `${name} is updated`, body: "Its words are the new version's and its name stays. Notes and journal pages you started from it don't change.", open: "Open the template" };
  if (kind === "theme" && beside) return { title: `The new ${name} is beside yours`, body: "Yours stays as you left it and no longer gets updates. The new one is in Appearance too, and your theme in use hasn't changed.", open: "Open the new one" };
  if (kind === "theme") return { title: `${name} is updated`, body: "Its colours and shape are the new version's, and its name stays. If you were using it, you're using the new version now.", open: "Open the theme" };
  if (kind === "checkin") return { title: `${name} is updated`, body: "Its old questions came out and the new ones joined at the end. Answers you've already given stay on their days.", open: "Open check-in settings" };
  const open = kind === "assistant" ? `Open ${name}` : kind === "skill" ? "Open the skill" : "Open the flow";
  const off = kind === "assistant" ? "paused" : "off";
  return { title: `${name} is updated, and ${off}`, body: `Its name and history stay. Look it over on its page, then switch it back on.`, open };
}

/** Under the Update button: what it changes. */
export function updateLandsWords(kind: ShareKind, changed = false): string {
  if (kind === "template") return changed ? "Yours stays as you left it. The new version is added beside it." : "Its words become the new version's. Its name stays.";
  if (kind === "theme") return changed ? "Yours stays as you left it. The new version is added beside it." : "Its colours and shape become the new version's. Its name stays.";
  if (kind === "checkin") return "Its questions are swapped for the new ones. Your answers stay on their days.";
  return `Yours ${kind === "assistant" ? "pauses" : "goes off"} until you switch it back on. Its name and history stay.`;
}

/** The Add button. */
export const addLabel = (kind: ShareKind, name: string): string => (kind === "assistant" ? `Add ${name} to your team` : `Add ${name}`);

/** Under the Add button: how it lands. */
export function landsWords(kind: ShareKind): string {
  if (kind === "template") return "It joins your templates. Nothing of yours changes, and you can remove it later.";
  if (kind === "theme") return "It joins your themes in Appearance. Add keeps the theme you have now; Add and use switches to it.";
  if (kind === "checkin") return "They join your own questions, after the ones you have. Nothing you have moves, and you can remove them later.";
  if (kind === "assistant") return "It joins paused. Nothing runs until you switch it on.";
  if (kind === "skill") return "It starts off. Ask won't use it until you switch it on.";
  return "It starts off. Nothing runs until you switch it on.";
}

// ---------- check-in questions ----------

const ROUTINE: Record<CheckinKind, string> = { morning: "morning preparation", evening: "evening reflection" };

/** "Morning", "Evening", "Morning and evening": a group on the preview. Pure. */
export const routinesWords = (kinds: readonly CheckinKind[]): string => (kinds.length > 1 ? "Morning and evening" : kinds[0] === "morning" ? "Morning" : "Evening");

/** The note when a routine the questions join is switched off: it stays off. Null when none is. Pure. */
export function offWords(off: readonly CheckinKind[]): string | null {
  if (!off.length) return null;
  const both = off.length > 1;
  const which = both ? "Your morning preparation and evening reflection are" : `Your ${ROUTINE[off[0]]} is`;
  return `${which} switched off. Adding these won't switch ${both ? "them" : "it"} on: ${both ? "they stay" : "it stays"} off until you do, in Settings.`;
}

/** Under a question the owner already has. */
export const HAVE_QUESTION = "You already have this one, so it won't be added again";

/** Go deeper on a shared question: the line the preview shows when one of its questions offers it. */
export const DEEPER_WORDS = "Like your own questions, any that offer Go deeper send the question and what you wrote to the AI model you chose, but only when you tap it.";

/**
 * "Where your answers go" for a set, from the kinds of answer in it and Athena's rule (lib/checkin-types.ts
 * ownMirror, the same for the owner's own questions): written answers go to that day's journal, the rest stay in the
 * check-ins. Pure.
 */
export function answersGoWords(types: readonly QuestionType[]): string[] {
  const journal = types.some((t) => ownMirror(t) === "day_journal");
  const rest = types.some((t) => ownMirror(t) !== "day_journal");
  const lines: string[] = [];
  if (journal) lines.push("Written answers go into that day's journal, like your other written answers. Change or undo one and the journal follows.");
  lines.push(journal ? (rest ? "Your other answers stay in your check-ins." : "") : "Your answers stay in your check-ins.");
  lines.push("Athena decides where answers go, whatever the file says. They never set your mood or go to Health.");
  lines.push("How many questions you're asked each day stays as you set it.");
  return lines.filter(Boolean);
}

/** The Add screen's two ways to start, each with its one-line consequence. `off`: routines they join that are off. Pure. */
export function startWords(off: readonly CheckinKind[], joins: readonly CheckinKind[]): { legend: string; on: { label: string; line: string }; off: { label: string; line: string } } {
  const allOff = joins.length > 0 && joins.every((k) => off.includes(k));
  const routines = off.length > 1 ? "your morning preparation and evening reflection" : `your ${ROUTINE[off[0] ?? "evening"]}`;
  return {
    legend: "When to start",
    on: { label: "Start asking them", line: allOff ? `They take turns with your other questions once you switch ${routines} on.` : "They take turns with your other questions from your next check-in." },
    off: { label: "Add them switched off", line: "They wait in Settings until you switch the set on." },
  };
}

/** The note when a set is bigger than the room left among the owner's own questions. Null when it fits. Pure. */
export function roomWords(fresh: number, room: number): string | null {
  if (fresh <= room) return null;
  if (room <= 0) return "You have 40 questions of your own, the most Athena keeps, so none of these can be added. Remove some in Settings first.";
  return `There's room for ${room === 1 ? "one more question" : `${room} more questions`} of your own, so the first ${room === 1 ? "one is" : `${room} are`} added and the other ${fresh - room === 1 ? "one is" : `${fresh - room} are`} left out.`;
}

/** The confirmation once check-in questions are added: how many joined which routines, what was skipped, what's off. Pure. */
export function checkinAddedWords(name: string, got: { added: number; skipped: readonly string[]; off: readonly CheckinKind[]; full?: readonly string[] }, joined: readonly CheckinKind[], started = true): { title: string; body: string; open: string } {
  const open = "Open check-in settings";
  const full = got.full ?? [];
  if (!got.added && full.length) return { title: `There wasn't room for ${name}`, body: "You have 40 questions of your own, the most Athena keeps. Remove some in Settings, then add these again.", open };
  if (!got.added) return { title: `You already have every question in ${name}`, body: "Nothing new was added. It's listed in Settings, where you can remove it.", open };
  const where = joined.length > 1 ? "your morning preparation and evening reflection" : `your ${ROUTINE[joined[0] ?? "evening"]}`;
  const parts = [`${got.added === 1 ? "One question" : `${got.added} questions`} joined ${where}, after the ones you have.`];
  if (got.skipped.length === 1) parts.push(`You already had “${got.skipped[0]}”, so it was left out.`);
  else if (got.skipped.length > 1) parts.push(`You already had ${got.skipped.length} of them, so those were left out.`);
  if (full.length === 1) parts.push(`There wasn't room for “${full[0]}”: you have 40 questions of your own, the most Athena keeps.`);
  else if (full.length > 1) parts.push(`There wasn't room for the other ${full.length}: you have 40 questions of your own, the most Athena keeps.`);
  if (!started) parts.push("The set is switched off, so they won't be asked until you switch it on in Settings.");
  // A routine that's off stays off either way, and is named either way.
  const off = offWords(got.off);
  if (off) parts.push(off);
  return { title: `${name} joined your check-ins`, body: parts.join(" "), open };
}

// ---------- a note template ----------

/**
 * "Where it goes" for a template: into the owner's templates beside their own, under a free name, and where it can be
 * used. `free`: the name it will have, which differs from `name` when one of the owner's templates has that name. Pure.
 */
export function templateGoesWords(name: string, free: string): string[] {
  const lines = [free === name ? `It joins your templates as “${name}”. Its editor says who made it.` : `You have a template called “${name}” already, so this one joins as “${free}”. Yours stays as it is.`];
  lines.push("Use it from Notes, under “From template”, or to start a day's journal when the page is empty.");
  lines.push("You can change it once it's added. Updates from Community never overwrite your changes.");
  return lines;
}

/** Under "Its fields": how a field fills in, as the template editor says. Pure. */
export function fieldLine(info: { source: string } | null): string {
  return info ? info.source : "Athena doesn't know this one, so it stays a blank for you";
}

/** The note when reading a template made something in it plain. Null when nothing changed. Pure. */
export function madePlainWords(changed: boolean): string | null {
  return changed ? "Athena made its links plain and left out any pictures or embedded pages, so nothing in it loads by itself." : null;
}

/** The confirmation once a template is added, with its free name when it needed one. Pure. */
export function templateAddedWords(asked: string, got: { name: string; renamed: boolean }): { title: string; body: string; open: string } {
  const parts = [got.renamed ? `You already had a template called “${asked}”, so this one is “${got.name}”.` : null, "Use it from Notes, under “From template”. On a day whose journal is empty, it's under “Start from a template” too."];
  return { title: `${got.name} is in your templates`, body: parts.filter(Boolean).join(" "), open: "Open the template" };
}

// ---------- a theme ----------

/** "Light", "Dark": a preview's caption. */
export const SCHEME_WORDS = { light: "Light", dark: "Dark" } as const;

/**
 * The line under the previews when a theme sets colours for one mode only, or none: the other keeps Athena's own.
 * Null when it sets both. Pure.
 */
export function themeModesWords(schemes: readonly ("light" | "dark")[]): string | null {
  if (schemes.length === 2) return null;
  if (!schemes.length) return "It keeps Athena's own colours in light and dark. Only its corners, spacing and text size can differ.";
  return schemes[0] === "light" ? "It has light colours only. In dark mode Athena keeps its own." : "It has dark colours only. In light mode Athena keeps its own.";
}

/** "Try it on Athena": the button, what it does, and the button once it's on. */
export const TRY_WORDS = {
  label: "Try it on Athena",
  line: "See it on the whole app first. Nothing is kept unless you add it.",
  on: "Put yours back",
  onLine: "You're seeing it on the whole app now. Leaving this page puts yours back too.",
  /** Trying it in a mode it has no colours for: only its shape and text size show. */
  onLineOther: (mode: "light" | "dark") => `It has no ${mode} colours, so in ${mode} mode you see only its corners, spacing and text size. Leaving this page puts yours back.`,
} as const;

/**
 * "Where it goes" for a theme: into the person's themes under a free name, beside theirs; what Add and Add and use do;
 * and that their own font and text size stay. `free`: the name it will have. Pure.
 */
export function themeGoesWords(name: string, free: string): string[] {
  return [
    free === name ? `It joins your themes in Appearance as “${name}”. Its editor says who made it.` : `You have a theme called “${name}” already, so this one joins as “${free}”. Yours stays as it is.`,
    "Your own font and text size stay as you set them, whatever the theme.",
    "You can change it once it's added. Updates from Community never overwrite your changes.",
  ];
}

/** The note when there's no room for another theme. Null when there is. Pure. */
export const themeRoomWords = (room: boolean): string | null => (room ? null : "You have 40 themes, the most Athena keeps. Delete one in Settings → Appearance to make room.");

/** The second button on a theme's preview. */
export const ADD_AND_USE = "Add and use";

/** The confirmation once a theme is added, with its free name when it needed one, and whether it's in use. Pure. */
export function themeAddedWords(asked: string, got: { name: string; renamed: boolean; used: boolean }): { title: string; body: string; open: string } {
  const parts = [got.renamed ? `You already had a theme called “${asked}”, so this one is “${got.name}”.` : null, got.used ? "To switch back, pick another theme in Settings → Appearance." : "Your theme hasn't changed. To use this one, pick it in Settings → Appearance."];
  return { title: got.used ? `You're using ${got.name}` : `${got.name} is in your themes`, body: parts.filter(Boolean).join(" "), open: got.used ? "Open Appearance" : "Open the theme" };
}

/**
 * What reading the file dropped or changed, in plain words, one line per kind of thing: a key Athena doesn't know, a
 * value that isn't a colour, a number brought into range, chart colours too alike. Empty when nothing was. Pure.
 */
export function themeProblemWords(problems: ReadonlyArray<{ path: string; why: string }>): string[] {
  const by = (why: string) => problems.filter((p) => p.why === why).map((p) => p.path);
  const list = (xs: string[]) => {
    const shown = xs.slice(0, 4).map((x) => `“${x}”`);
    const more = xs.length - shown.length;
    return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown.join("");
  };
  const lines: string[] = [];
  const unknown = by("unknown");
  if (unknown.length) lines.push(`Left out ${list(unknown)}: a theme can't have ${unknown.length === 1 ? "that" : "those"}.`);
  const colours = by("not-a-colour");
  if (colours.length) lines.push(`Used Athena's own colour for ${list(colours)}, which ${colours.length === 1 ? "wasn't a plain colour" : "weren't plain colours"}.`);
  const clamped = by("clamped").concat(by("not-a-number"));
  if (clamped.length) lines.push(`Brought ${list(clamped)} into the range Athena allows.`);
  const close = by("chart-close");
  if (close.length) lines.push(`Kept Athena's chart colours for ${close.map((p) => (p.endsWith("dark") ? "dark mode" : "light mode")).join(" and ")}: some of its own were too alike to tell apart.`);
  const size = by("chart-size");
  if (size.length) lines.push(`Kept Athena's chart colours for ${size.map((p) => (p.endsWith("dark") ? "dark mode" : "light mode")).join(" and ")}: a chart needs exactly five.`);
  const text = by("too-long").concat(by("not-text"), by("not-a-handle"));
  if (text.length) lines.push(`Shortened or left out ${list(text)}.`);
  return lines;
}

// ---------- a flow's steps ----------

/** Tools that change something: a flow step using one waits for the owner's Go once added. The rest only look. */
export const FLOW_CHANGE_TOOLS: ReadonlySet<string> = new Set(FLOW_SHARE_TOOLS.filter((t) => !FLOW_LOOK_TOOLS.includes(t)));

export const changesSomething = (s: SharedFlowStep): boolean => s.kind === "tool" && FLOW_CHANGE_TOOLS.has(s.tool);

/** The line under a step that changes something. */
export function goWords(s: SharedFlowStep): string | null {
  if (s.kind !== "tool" || !changesSomething(s)) return null;
  if (FLOW_DRAFT_TOOLS.includes(s.tool)) return "A draft: it always waits for your approval, and nothing is sent";
  return s.go === "auto" ? "It asked to run on its own. You can allow that once it's added" : null;
}

/**
 * A tool step's filled fields, in the order the step's sheet lists them (the catalogue's), as the flow editor shows a
 * step: the first is its body, the rest each go under it with the field's name ("Day", "Time"). A field the catalogue
 * doesn't know keeps its key, in words. Pure.
 */
export function toolStepFields<T extends readonly unknown[]>(input: Readonly<Record<string, T>>, fields: ReadonlyArray<{ key: string; label: string }> = []): { first: string | null; rest: Array<{ key: string; label: string }> } {
  const known = fields.map((f) => f.key);
  const keys = [...known.filter((k) => k in input), ...Object.keys(input).filter((k) => !known.includes(k))].filter((k) => (input[k] ?? []).length);
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { first: keys[0] ?? null, rest: keys.slice(1).map((key) => ({ key, label: label(key) })) };
}

/** The hint under a question whose answer is one of the owner's records, lists or contexts. Empty for words. */
export function fillsWords(fills: string, pick?: FlowPick): string {
  if (pick === "list") return "The name of one of your lists. A new name starts a new list";
  if (pick) return "Pick one of your to-do contexts";
  if (fills === "text") return "";
  if (fills === "person") return "Pick one of your people";
  return `Type the name of one of your ${fills === "todo" ? "to-dos" : `${fills}s`}`;
}
