/**
 * The shape of a day: one quiet track from morning to night with what
 * happened when (a workout, the calendar, what you watched, played and heard),
 * each mark as long as it lasted. Media is coloured by kind and the calendar
 * by its label (work, personal, family…); a small key names only what's there.
 * A picture of the day's rhythm; the words around it carry the detail, and its
 * label says it in a sentence.
 */

import { h } from "../lib/dom";
import type { Day } from "../db/days-app";
import { calendarLabelOrder } from "../../../lib/day-types";
import { clockOfDay, uses12Hour } from "../lib/clock";

type Lane = "move" | "cal" | "media";
type MediaKind = "watched" | "listened" | "played" | "read";
interface Mark {
  lane: Lane;
  start: number;
  minutes: number;
  label: string;
  /** What its colour stands for: a media kind, a calendar label, or "" (no label). */
  key: string;
}
export interface KeyItem {
  lane: Lane;
  key: string;
  word: string;
  /** A colour token, e.g. "--chart-3". */
  tone: string;
}

const LANE_WORD: Record<Lane, string> = { move: "Moving", cal: "Calendar", media: "Media" };
const DAY_END = 24 * 60;
/** A timed event with no end Athena knows of. */
const MEETING_MINUTES = 45;

const MEDIA_KINDS: MediaKind[] = ["watched", "listened", "played", "read"];
const MEDIA_TONE: Record<MediaKind, string> = { watched: "--chart-1", listened: "--chart-3", played: "--chart-4", read: "--chart-5" };
const MEDIA_WORD: Record<MediaKind, string> = { watched: "Watched", listened: "Listened", played: "Played", read: "Read" };
/** Calendar labels take these in order: work, personal, then others alphabetically. Past four they go neutral. */
const CAL_TONES = ["--chart-1", "--chart-3", "--chart-4", "--chart-5"];
const NEUTRAL = "--ink-3";

/** Minutes since midnight, in this device's zone. */
const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes();
};
const hhmm = (m: number, hour12 = uses12Hour()) => clockOfDay(`${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, hour12);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Each label on the day and its colour. Work and personal always take the first two; other labels take
 * their place in the owner's full list (`owner`, Day.calendar_labels), so a label keeps its colour whatever
 * else is on the day. A label missing from that list follows it alphabetically. Past four, neutral.
 */
export function calendarTones(labels: Iterable<string>, owner: readonly string[] = []): Map<string, string> {
  const day = new Set([...labels].filter(Boolean));
  const known = calendarLabelOrder(owner);
  const others = [...known, ...calendarLabelOrder(day).filter((l) => !known.includes(l))].filter((l) => l !== "work" && l !== "personal");
  const out = new Map<string, string>();
  for (const l of calendarLabelOrder(day)) out.set(l, l === "work" ? CAL_TONES[0] : l === "personal" ? CAL_TONES[1] : (CAL_TONES[2 + others.indexOf(l)] ?? NEUTRAL));
  return out;
}

export function dayMarks(day: Day): Mark[] {
  const marks: Mark[] = [];
  for (const w of day.health?.workouts ?? []) {
    if (!w.start) continue;
    const [hh, mm] = w.start.split(":").map(Number);
    marks.push({ lane: "move", start: hh * 60 + mm, minutes: w.minutes, label: w.type, key: "" });
  }
  for (const e of day.events) {
    const s = e.starts_at ? minutesOf(e.starts_at) : null;
    if (s === null) continue;
    const ends = e.ends_at ? Date.parse(e.ends_at) - Date.parse(e.starts_at!) : NaN;
    const minutes = ends > 0 ? Math.max(1, Math.round(ends / 60_000)) : MEETING_MINUTES;
    marks.push({ lane: "cal", start: s, minutes: Math.min(minutes, DAY_END - s), label: e.title, key: e.label?.trim().toLowerCase() ?? "" });
  }
  for (const e of day.entries) {
    if (!e.at || !(MEDIA_KINDS as string[]).includes(e.kind)) continue;
    const s = minutesOf(e.at);
    if (s !== null) marks.push({ lane: "media", start: s, minutes: Math.min(e.minutes ?? (e.kind === "listened" ? 4 : 30), DAY_END - s), label: e.title, key: e.kind });
  }
  return marks.sort((a, b) => a.start - b.start);
}

/** The colour token for one mark, given the day's calendar tones. */
function toneOf(m: Mark, cal: Map<string, string>): string {
  if (m.lane === "move") return "--chart-2";
  if (m.lane === "media") return MEDIA_TONE[m.key as MediaKind];
  return cal.get(m.key) ?? NEUTRAL;
}

/** "Work calendar", "Watched": what a mark's colour says, or null for an unlabelled event or a workout. */
function keyWord(m: Mark): string | null {
  if (m.lane === "media") return MEDIA_WORD[m.key as MediaKind];
  if (m.lane === "cal" && m.key) return `${capital(m.key)} calendar`;
  return null;
}

/** "13:00 Design review · Work calendar". */
export function markText(m: Mark, hour12 = uses12Hour()): string {
  const word = keyWord(m);
  return `${hhmm(m.start, hour12)} ${m.label}${word ? ` · ${word}` : ""}`;
}

/** The key: only the kinds and labels this day has, calendar first, each in its fixed colour order. */
export function ribbonKey(marks: Mark[], owner: readonly string[] = []): KeyItem[] {
  const calMarks = marks.filter((m) => m.lane === "cal");
  const cal = calendarTones(calMarks.map((m) => m.key), owner);
  const items: KeyItem[] = [];
  for (const [key, tone] of cal) if (tone !== NEUTRAL) items.push({ lane: "cal", key, word: capital(key), tone });
  // Unlabelled events (and labels past the fourth) share the neutral ink: named once, and only beside a coloured label.
  if (items.length && calMarks.some((m) => toneOf(m, cal) === NEUTRAL)) items.push({ lane: "cal", key: "", word: "Other", tone: NEUTRAL });
  for (const k of MEDIA_KINDS) if (marks.some((m) => m.lane === "media" && m.key === k)) items.push({ lane: "media", key: k, word: MEDIA_WORD[k], tone: MEDIA_TONE[k] });
  return items;
}

/** What the picture says, for a screen reader: the span, then each lane's marks by time with their kind or calendar. */
export function ribbonLabel(marks: Mark[], hour12 = uses12Hour()): string {
  const first = Math.min(...marks.map((m) => m.start));
  const last = Math.max(...marks.map((m) => m.start + m.minutes));
  const lanes = (["move", "cal", "media"] as Lane[]).filter((l) => marks.some((m) => m.lane === l));
  const parts = lanes.map((l) => `${LANE_WORD[l]}: ${marks.filter((m) => m.lane === l).map((m) => markText(m, hour12)).join("; ")}.`);
  return `Your day from ${hhmm(first, hour12)} to ${hhmm(Math.min(last, DAY_END - 1), hour12)}. ${parts.join(" ")}`;
}

export function dayRibbon(day: Day): HTMLElement | null {
  const marks = dayMarks(day);
  if (marks.length < 3) return null;
  const first = Math.min(...marks.map((m) => m.start));
  const last = Math.max(...marks.map((m) => m.start + m.minutes));
  const from = Math.max(0, Math.min(7 * 60, Math.floor(first / 60) * 60));
  const to = Math.min(DAY_END, Math.max(22 * 60, Math.ceil(last / 60) * 60));
  const span = to - from;
  const pct = (m: number) => `${(((m - from) / span) * 100).toFixed(2)}%`;
  const cal = calendarTones(marks.filter((m) => m.lane === "cal").map((m) => m.key), day.calendar_labels);

  const lanes = (["move", "cal", "media"] as Lane[]).filter((l) => marks.some((m) => m.lane === l));
  const rows = h("div", { class: "ribbon__rows", "aria-hidden": "true" });
  for (const lane of lanes) {
    const row = h("span", { class: `ribbon__row ribbon__lane--${lane}` });
    let prev: { end: number; tone: string } | null = null;
    for (const m of marks.filter((x) => x.lane === lane)) {
      const w = Math.max(1.2, (m.minutes / span) * 100);
      const tone = toneOf(m, cal);
      const over = prev !== null && prev.tone !== tone && m.start < prev.end;
      row.append(h("span", { class: `ribbon__mark${over ? " is-over" : ""}`, style: `left:${pct(m.start)};width:${w.toFixed(2)}%;--lane:var(${tone})`, title: markText(m) }));
      const end = m.start + Math.max(m.minutes, (1.2 / 100) * span);
      prev = prev && prev.end > end && prev.tone === tone ? prev : { end, tone };
    }
    rows.append(h("span", { class: "ribbon__name" }, LANE_WORD[lane]), row);
  }
  const hours = h("span", { class: "ribbon__hours" });
  for (let t = Math.ceil(from / 180) * 180; t < to; t += 180) if (t !== from) hours.append(h("span", { class: "ribbon__hour", style: `left:${pct(t)}` }, hhmm(t)));
  rows.append(hours);

  const items = ribbonKey(marks, day.calendar_labels);
  const key = h("div", { class: "ribbon__keys", "aria-hidden": "true" });
  for (const lane of ["cal", "media"] as Lane[]) {
    const mine = items.filter((it) => it.lane === lane);
    if (!mine.length) continue;
    key.append(
      h(
        "span",
        { class: "ribbon__key" },
        h("span", { class: "ribbon__key-name" }, LANE_WORD[lane]),
        h("span", { class: "ribbon__key-items" }, ...mine.map((it) => h("span", { class: "ribbon__key-item", style: `--lane:var(${it.tone})` }, it.word))),
      ),
    );
  }
  return h(
    "section",
    { class: "ribbon", "aria-label": "The shape of the day" },
    h("h2", { class: "ribbon__head" }, "The shape of the day"),
    h("figure", { role: "img", "aria-label": ribbonLabel(marks) }, rows, ...(key.childElementCount ? [key] : [])),
  );
}
