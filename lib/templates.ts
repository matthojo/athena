/**
 * Note templates: Markdown with fill-in fields such as {{attendees}} or
 * {{trip legs}}. Pure (no I/O), shared by the server (lib/template-fill.ts
 * fills them from Athena's own records) and the PWA (the picker, the
 * template editor, and highlighting blanks in the note editor).
 *
 * Rules:
 *  - every field has one named source (FIELDS); a field nobody knows is left
 *    as a blank for the owner;
 *  - a value only ever comes from a record Athena holds, never from a model:
 *    nothing is invented, and a field with nothing to say stays a blank;
 *  - each filled field is cited in a Sources list at the foot of the note.
 */
import { formatAthenaLink, type LinkKind } from "./links";

// ---------- fields ----------

/** What a field needs before it can be filled. */
export type FieldContext = "meeting" | "person" | "trip" | "project" | "week" | "none";

export interface FieldInfo {
  /** The normalised name, as written between the braces. */
  key: string;
  /** Where its value comes from, for the template editor: "The meeting's guests, from your calendar". */
  source: string;
  needs: FieldContext;
}

/** Known fields. Aliases map to the same source. */
export const FIELDS: FieldInfo[] = [
  { key: "meeting", source: "The meeting's title, from your calendar", needs: "meeting" },
  { key: "date", source: "When the meeting is, or today", needs: "none" },
  { key: "today", source: "Today's date", needs: "none" },
  { key: "attendees", source: "Who's invited, from your calendar and People", needs: "meeting" },
  { key: "person", source: "The person it's with, from People", needs: "person" },
  { key: "last time we spoke", source: "Your latest catch-up with them", needs: "person" },
  { key: "about them", source: "Details you've saved about them", needs: "person" },
  { key: "open loops", source: "Open to-dos with them, both ways", needs: "person" },
  { key: "agenda from email", source: "An email about the meeting, from Email digest notes", needs: "meeting" },
  { key: "trip", source: "The trip's name, from Trips", needs: "trip" },
  { key: "trip dates", source: "The trip's dates, from Trips", needs: "trip" },
  { key: "trip legs", source: "Flights, trains and stays, from Trips", needs: "trip" },
  { key: "week", source: "The week's dates", needs: "week" },
  { key: "this week's days", source: "Each day's line, from Days", needs: "week" },
  { key: "this week's done to-dos", source: "To-dos you ticked off this week", needs: "week" },
  { key: "open to-dos", source: "Your open to-dos due in the next week", needs: "none" },
  { key: "project", source: "The project's name, from Projects", needs: "project" },
  { key: "open to-dos for project", source: "Open to-dos linked to the project", needs: "project" },
  { key: "project people", source: "People linked to the project", needs: "project" },
  { key: "my name", source: "Your name, from your profile", needs: "none" },
];

const ALIASES: Record<string, string> = {
  guests: "attendees",
  who: "attendees",
  when: "date",
  "meeting title": "meeting",
  name: "person",
  them: "person",
  "last catch-up": "last time we spoke",
  "last catch up": "last time we spoke",
  "what i know": "about them",
  agenda: "agenda from email",
  legs: "trip legs",
  "this week": "this week's days",
  days: "this week's days",
  "open todos": "open to-dos",
  "open to-dos for the project": "open to-dos for project",
};

/** "  Last  Time we Spoke " → "last time we spoke"; curly apostrophes count as straight ones. */
export function fieldKey(raw: string): string {
  const k = raw.trim().replace(/\s+/g, " ").replace(/[‘’]/g, "'").toLowerCase();
  return ALIASES[k] ?? k;
}

export function fieldInfo(raw: string): FieldInfo | null {
  const key = fieldKey(raw);
  return FIELDS.find((f) => f.key === key) ?? null;
}

/** {{ name }}: up to 60 characters, no braces or line breaks. */
const FIELD_RE = /\{\{([^{}\n]{1,60})\}\}/g;

export interface ParsedField {
  /** As written: "last time we spoke". */
  name: string;
  key: string;
  info: FieldInfo | null;
}

/** The fields in a template, once each, in the order they first appear. */
export function parseTemplate(body: string): ParsedField[] {
  const seen = new Map<string, ParsedField>();
  for (const m of body.matchAll(FIELD_RE)) {
    const name = m[1].trim();
    if (!name) continue;
    const key = fieldKey(name);
    if (!seen.has(key)) seen.set(key, { name, key, info: fieldInfo(name) });
  }
  return [...seen.values()];
}

/** What the template needs picked before it can be filled: a meeting, a person, a trip, a project. */
export function templateNeeds(body: string): FieldContext[] {
  const needs = new Set<FieldContext>();
  for (const f of parseTemplate(body)) if (f.info && f.info.needs !== "none") needs.add(f.info.needs);
  // A meeting brings its people, so person fields are filled from it too.
  if (needs.has("meeting")) needs.delete("person");
  return [...needs];
}

/** Where blanks are in some text, for highlighting: [start, end) of each {{…}}. */
export function blankRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(FIELD_RE)].map((m) => [m.index!, m.index! + m[0].length]);
}

// ---------- filling ----------

/** Where part of a filled note came from. A kind and id make it a link; a trip or a day isn't a link kind, so it's text. */
export interface Cite {
  label: string;
  kind?: LinkKind;
  id?: string;
  /** "Tue 10 Nov", "catch-up on 3 Nov". */
  detail?: string;
}

export interface FieldValue {
  /** One line, or several (each becomes a list item when the field stands on its own line). */
  lines: string[];
  sources: Cite[];
}

/** For each field key: its value, or null when nothing was found (it stays a blank). */
export type FieldValues = Record<string, FieldValue | null>;

export interface FilledTemplate {
  body: string;
  /** Field names that stay blank, as written. */
  blanks: string[];
  /** Field names that were filled, with where from. */
  filled: Array<{ name: string; sources: Cite[] }>;
}

export const SOURCES_HEADING = "Sources";

const citeText = (c: Cite) => {
  const label = c.kind && c.id ? formatAthenaLink(c.kind, c.id, c.label, "link") : c.label;
  return c.detail ? `${label}, ${c.detail}` : label;
};

/**
 * Put the values into the template. A field alone on its line (or after a
 * list marker) takes every line as a list; inline, the lines are joined with
 * commas. A field with no value stays exactly as written, {{like this}}, so
 * the owner sees it. The Sources list goes at the foot.
 */
export function fillTemplate(body: string, values: FieldValues): FilledTemplate {
  const blanks = new Set<string>();
  const filled = new Map<string, { name: string; sources: Cite[] }>();
  const out = body.split("\n").map((line) => {
    // The whole line is one field (optionally after "- "): a list.
    const alone = /^(\s*)(?:([-*]|\d+\.)\s+)?\{\{([^{}\n]{1,60})\}\}\s*$/.exec(line);
    if (alone) {
      const [, indent, marker, name] = alone;
      const value = values[fieldKey(name)];
      if (!value || !value.lines.length) {
        blanks.add(name.trim());
        return line;
      }
      filled.set(fieldKey(name), { name: name.trim(), sources: value.sources });
      // One plain line stays a line; several, or a to-do ("[ ] …"), become a list.
      if (value.lines.length === 1 && !marker && !value.lines[0].startsWith("[ ] ")) return `${indent}${value.lines[0]}`;
      const bullet = marker && /\d/.test(marker) ? null : "-";
      return value.lines.map((l, i) => `${indent}${bullet ?? `${i + 1}.`} ${l}`).join("\n");
    }
    return line.replace(FIELD_RE, (whole, name: string) => {
      const value = values[fieldKey(name)];
      if (!value || !value.lines.length) {
        blanks.add(name.trim());
        return whole;
      }
      filled.set(fieldKey(name), { name: name.trim(), sources: value.sources });
      return value.lines.join(", ");
    });
  });
  // Fields with the same sources share a line: "Meeting, date and attendees: Design review, Tue 10 Nov".
  const grouped = new Map<string, { names: string[]; sources: Cite[] }>();
  for (const f of filled.values()) {
    if (!f.sources.length) continue;
    const key = f.sources.map(citeText).join("; ");
    const g = grouped.get(key) ?? { names: [], sources: f.sources };
    g.names.push(f.name);
    grouped.set(key, g);
  }
  const foot: string[] = [];
  if (grouped.size || blanks.size) {
    foot.push("", "", "---", "", `### ${SOURCES_HEADING}`, "");
    for (const [cited, g] of grouped) foot.push(`- ${capitalise(listWords(g.names))}: ${cited}`);
    if (blanks.size) foot.push(`- Left for you: ${[...blanks].join(", ")}`);
  }
  return { body: trimEnd(out.join("\n")) + foot.join("\n"), blanks: [...blanks], filled: [...filled.values()] };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Trailing blank lines go; a checklist's last "- [ ] " keeps its space. */
const trimEnd = (s: string) => s.replace(/\n\s*$/, "");
const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The note's title: its first "# " heading once filled, else the template's name. */
export function filledTitle(body: string, fallback: string): string {
  const h = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return h && !h.includes("{{") ? h.slice(0, 200) : fallback;
}

/**
 * A note has its own title, so a filled template's opening "# heading"
 * becomes the title and leaves the body (a heading still holding a blank
 * stays, so the blank isn't lost).
 */
export function splitTitle(body: string, fallback: string): { title: string; body: string } {
  const m = /^\s*#\s+(.+)\n+/.exec(body);
  if (!m || m[1].includes("{{")) return { title: filledTitle(body, fallback), body };
  return { title: m[1].trim().slice(0, 200), body: body.slice(m[0].length) };
}

// ---------- the starters ----------

export interface StarterTemplate {
  /** Stable key; an edited starter is saved with it (note_templates.starter). */
  key: string;
  name: string;
  /** One line for the picker. */
  blurb: string;
  body: string;
}

export const STARTERS: StarterTemplate[] = [
  {
    key: "meeting",
    name: "Meeting notes",
    blurb: "Who's coming, and what's still open with them",
    body: `# {{meeting}}

{{date}} · {{attendees}}

## Agenda
{{agenda from email}}

## Last time
{{last time we spoke}}

## Open loops
{{open loops}}

## Notes


## Decisions


## Actions
- [ ] `,
  },
  {
    key: "one-on-one",
    name: "1:1",
    blurb: "What's happened since you last spoke",
    body: `# 1:1 with {{person}}

{{date}}

## Since last time
{{last time we spoke}}

## Worth remembering
{{about them}}

## Open loops
{{open loops}}

## Their topics


## My topics


## Actions
- [ ] `,
  },
  {
    key: "trip",
    name: "Trip plan",
    blurb: "Every leg, and what to do before you go",
    body: `# {{trip}}

{{trip dates}}

## Legs
{{trip legs}}

## Before you go
{{open to-dos}}

## Packing
- [ ] Passport
- [ ] Chargers

## Ideas
`,
  },
  {
    key: "weekly-review",
    name: "Weekly review",
    blurb: "Each day, and what got done",
    body: `# Week of {{week}}

## The days
{{this week's days}}

## Done
{{this week's done to-dos}}

## Still open
{{open to-dos}}

## Went well


## To change


## Next week's three
1. `,
  },
  {
    key: "letter",
    name: "Letter",
    blurb: "Dated and addressed, with the rest for you",
    body: `{{today}}

Dear {{person}},



Best wishes,
{{my name}}`,
  },
  {
    key: "project-brief",
    name: "Project brief",
    blurb: "Why it matters and who's involved",
    body: `# {{project}}

## Why


## What done looks like


## People
{{project people}}

## Open to-dos
{{open to-dos for project}}

## Risks

`,
  },
];

export const TEMPLATE_LIMITS = { name: 80, body: 20_000, count: 100 } as const;

// ---------- a day's journal ----------

/**
 * A template as a day's journal starts from it (app/src/components/journal-start.ts). The journal belongs to its day,
 * which is its title, so an opening "# heading" is left out, and since the journal is plain text, the other headings
 * lose their "#" marks and stay as lines of their own (lists and to-dos keep theirs). {{date}} and {{today}} become the day's own date, and
 * {{week}} its week: the day the owner is writing about, not the day they're writing on. Every other field stays
 * exactly as written, as a blank for them, since a journal has no meeting, person or trip to fill it from and nothing
 * is ever made up. No Sources list: nothing was filled from a record. Pure.
 */
export function journalFromTemplate(body: string, day: { date: string; week: string }): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first > -1 && /^#\s+\S/.test(lines[first])) lines.splice(first, 1);
  const text = lines
    .map((l) => l.replace(/^#{1,6}\s+/, ""))
    .join("\n")
    .replace(FIELD_RE, (whole, name: string) => {
      const key = fieldKey(name);
      if (key === "date" || key === "today") return day.date;
      if (key === "week") return day.week;
      return whole;
    })
    .replace(/^\s*\n/, "")
    .replace(/\n\s*$/, "");
  return text.trim() ? text : "";
}
