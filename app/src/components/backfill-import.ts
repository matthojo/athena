/**
 * Imports that backfill Days from other apps' exports: Loop Habit Tracker,
 * Daylio, Bearable, Overcast and TfL journey history. Opened from each
 * service's card in Sources (the Add an account directory, and the "From
 * files" group once a file is in).
 *
 * The same shape as the Netflix import (netflix-import.ts, whose styles it
 * shares): steps to get the file, a picker, what's in it, progress, done.
 * The file is read here, on the device (lib/loop-csv.ts and friends), and
 * only what Days keeps goes to /api/days/import/:format, in batches. Every
 * request is safe to repeat, so stopping, losing the connection or importing
 * the same file again never adds anything twice.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { request } from "../db/api";
import { rememberImport } from "../lib/youtube-import-memo";
import { entriesFromZip, isZip } from "../lib/takeout-zip";
import { FileTooBig, MAX_CSV_BYTES, readText, TOO_BIG } from "../lib/file-limits";
import { batchDays, ImportFileError, parseLoopExport, type HabitDay } from "../../../lib/loop-csv";
import { parseDaylio, type MoodDay } from "../../../lib/daylio-csv";
import { parseBearable, type BearableDay } from "../../../lib/bearable-csv";
import { parseOvercast, type PodcastDay } from "../../../lib/overcast-opml";
import { parseTfl, type JourneyDay } from "../../../lib/tfl-csv";
import { backfillMark } from "./backfill-marks";
import "../styles/youtube-import.css";
import "../styles/goodreads-import.css";
import "../styles/netflix-import.css";
import "../styles/backfill-import.css";

export type BackfillFormat = "loop" | "daylio" | "bearable" | "overcast" | "tfl";

interface Target {
  collection: { id: string; name: string } | null;
  source: string;
}

interface BatchResult {
  days_created: number;
  days_updated: number;
  days_unchanged: number;
  days_skipped: number;
  added: number;
  moods_set: number;
  moods_kept: number;
  journals_added: number;
  health_days: number;
}

const ZERO: BatchResult = { days_created: 0, days_updated: 0, days_unchanged: 0, days_skipped: 0, added: 0, moods_set: 0, moods_kept: 0, journals_added: 0, health_days: 0 };

const n = (x: number) => x.toLocaleString("en-GB");
const count = (x: number, one: string, many: string) => `${n(x)} ${plural(x, one, many)}`;
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const monthYear = (day: string) => at(day).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => at(day).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What a file holds, as the review shows it. */
interface Parsed {
  days: Array<{ day: string }>;
  /** Things the file adds: habits ticked, episodes, journeys. */
  items: number;
  /** The headline count and its unit: "1,204 habits ticked". */
  headline: [number, string];
  /** Per day, for the bars and the batches. */
  size: (d: { day: string }) => number;
  /** "Most often: Meditate, Read and Run." */
  most?: string;
  /** Rows left out, said plainly. */
  left: string[];
  /** Where it goes: one row each. */
  rows: Array<{ icon: IconName; title: string; meta: string }>;
}

interface Spec {
  /** The service, as Sources names it. */
  name: string;
  title: string;
  /** For the file picker. */
  accept: string;
  /** The file the steps end with. */
  file: string;
  lede: string;
  steps: Array<{ title: string; sub: string; open?: string }>;
  /** What leaves the device. */
  privacy: string;
  /** For the import memo and the last-import line: [one, many]. */
  unit: [string, string];
  /** Problems by reason. */
  wrong: string;
  empty: string;
  read: (files: File[]) => Promise<Parsed>;
  /** The done screen's title and line. */
  done: (r: BatchResult) => { title: string; sub: string; extra: string[] };
}

const top = (names: Map<string, number>, k = 3) =>
  [...names.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([x]) => x);

function habitCounts(days: HabitDay[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of days) for (const x of d.habits) if (x.done) m.set(x.name, (m.get(x.name) ?? 0) + 1);
  return m;
}

const leftOut = (s: { undated: number; future: number }, what: [string, string]) =>
  [
    s.undated ? `${count(s.undated, what[0], what[1])} had no date Athena could read, so ${plural(s.undated, "it's", "they're")} left out.` : "",
    s.future ? `${count(s.future, what[0], what[1])} ${plural(s.future, "is", "are")} dated after today, so ${plural(s.future, "it's", "they're")} left out.` : "",
  ].filter(Boolean);

const moodRow = { icon: "heart" as IconName, title: "Moods fill the days you haven't rated", meta: "A mood you set in Athena always stays" };

function moodDone(r: BatchResult): string[] {
  if (!r.moods_set && !r.moods_kept) return [];
  if (!r.moods_set) return [`${count(r.moods_kept, "day", "days")} kept the mood you'd set.`];
  return [`${count(r.moods_set, "day", "days")} got a mood${r.moods_kept ? `, and ${n(r.moods_kept)} kept the one you'd set` : ""}.`];
}

const habitsDone = (r: BatchResult, extra: string[] = []) => ({
  title: r.added ? `Added ${count(r.added, "habit", "habits")}` : extra.length ? "Moods added" : "Nothing new to add",
  sub: r.added ? `Across ${count(r.days_created + r.days_updated, "day", "days")} in Days.` : extra.length ? "No new habits, but some days got a mood." : "Everything in this file is already in Days.",
  extra,
});

const SPECS: Record<BackfillFormat, Spec> = {
  loop: {
    name: "Loop Habit Tracker",
    title: "Import your habits",
    accept: ".zip,.csv,application/zip,text/csv",
    file: "Loop Habits CSV.zip",
    lede: "Loop keeps every tick on your phone. Export them once and Athena puts each habit on the day you did it.",
    steps: [
      { title: "Open Loop's settings", sub: "In Loop, tap the three dots at the top, then Settings." },
      { title: "Tap Export as CSV", sub: "Loop makes a zip of all your habits. Save it to Files or Google Drive, or email it to yourself." },
      { title: "Bring it here", sub: "Open Athena on the device that has the zip. You don't need to unzip it." },
    ],
    privacy: "Athena reads the zip on this device and sends only habit names and dates.",
    unit: ["check-in", "check-ins"],
    wrong: "That isn't Loop's export. In Loop, open Settings, tap Export as CSV, and choose the zip it makes.",
    empty: "There are no ticks in that export yet.",
    read: async (files) => {
      const entries = (await Promise.all(files.map(async (f) => ((await isZip(f)) ? entriesFromZip(f, /(^|\/)(Checkmarks|Habits)\.csv$/i, { paths: true }) : [{ name: f.name, text: await readText(f, MAX_CSV_BYTES) }])))).flat();
      const p = parseLoopExport(entries, { today: todayIso() });
      const done = p.days.reduce((k, d) => k + d.habits.filter((x) => x.done).length, 0);
      const skips = p.marks - done;
      const most = top(habitCounts(p.days));
      return {
        days: p.days,
        items: p.marks,
        headline: [done, plural(done, "habit ticked", "habits ticked")],
        size: (d) => (d as HabitDay).habits.length,
        most: most.length ? `Most often: ${list(most)}.` : undefined,
        left: [skips ? `And ${n(skips)} missed or skipped, which come over as skipped.` : "", ...leftOut(p.skipped, ["row", "rows"])].filter(Boolean),
        rows: [
          { icon: "loop", title: `${count(p.habits.length, "habit", "habits")} go into Days`, meta: "Each on the day you ticked it" },
          { icon: "check", title: "Missed days come over as skipped", meta: "So each day shows what you kept and what you didn't" },
        ],
      };
    },
    done: (r) => habitsDone(r),
  },
  daylio: {
    name: "Daylio",
    title: "Import your Daylio entries",
    accept: ".csv,text/csv",
    file: "daylio_export.csv",
    lede: "Daylio can export every entry as a spreadsheet. Athena takes the mood, the activities and the notes, day by day.",
    steps: [
      { title: "Open More, then Export entries", sub: "In Daylio, tap More at the bottom, then Export entries. Exporting needs Daylio Premium." },
      { title: "Choose CSV", sub: "Daylio makes daylio_export.csv. Save it to Files, or share it to this device." },
      { title: "Add it here", sub: "Run it again later with a newer export: nothing is added twice." },
    ],
    privacy: "Athena reads the file on this device. Moods and notes are encrypted on your server.",
    unit: ["entry", "entries"],
    wrong: "That isn't a Daylio export. In Daylio, open More, Export entries, and choose CSV.",
    empty: "There are no entries in that file.",
    read: async (files) => {
      const p = parseDaylio(await readText(files[0], MAX_CSV_BYTES), { today: todayIso() });
      const most = top(habitCounts(p.days));
      return {
        days: p.days,
        items: p.rows,
        headline: [p.rows, plural(p.rows, "entry", "entries")],
        size: (d) => (d as MoodDay).habits.length + 1,
        most: most.length ? `Most logged: ${list(most)}.` : undefined,
        left: [
          p.skipped.unknown_moods.length ? `Moods Athena doesn't know (${list(p.skipped.unknown_moods.slice(0, 3).map((m) => `“${m}”`))}) are left out. The rest of those entries comes over.` : "",
          ...leftOut(p.skipped, ["entry", "entries"]),
        ].filter(Boolean),
        rows: [
          { ...moodRow, title: `${count(p.moods, "mood", "moods")}, for the days you haven't rated` },
          { icon: "loop", title: `${count(p.habits.length, "activity", "activities")} as habits`, meta: "Each on the day you logged it" },
          ...(p.journals ? [{ icon: "pen" as IconName, title: `${count(p.journals, "day's notes", "days' notes")} in your journal`, meta: "Under “From Daylio”, after anything you wrote" }] : []),
        ],
      };
    },
    done: (r) => {
      const extra = [...moodDone(r), r.journals_added ? `${count(r.journals_added, "journal", "journals")} got Daylio's notes.` : ""].filter(Boolean);
      return habitsDone(r, extra);
    },
  },
  bearable: {
    name: "Bearable",
    title: "Import from Bearable",
    accept: ".csv,text/csv",
    file: "bearable-export.csv",
    lede: "Bearable exports everything you've tracked, free. Athena takes mood, energy, symptoms and factors.",
    steps: [
      { title: "Open Bearable's settings", sub: "In Bearable, tap the menu, then Settings." },
      { title: "Export your data as CSV", sub: "Pick all time. Bearable saves a CSV, or emails it to you." },
      { title: "Add it here", sub: "Save the file to Files or your downloads first." },
    ],
    privacy: "Athena reads the file on this device. Symptoms and energy are encrypted, like your health data.",
    unit: ["day", "days"],
    wrong: "That isn't a Bearable export. In Bearable's settings, export your data as CSV and choose that file.",
    empty: "There's no mood, energy, symptom or factor in that file.",
    read: async (files) => {
      const p = parseBearable(await readText(files[0], MAX_CSV_BYTES), { today: todayIso() });
      const most = top(habitCounts(p.days));
      return {
        days: p.days,
        items: p.days.length,
        headline: [p.days.length, plural(p.days.length, "day", "days")],
        size: (d) => (d as BearableDay).habits.length + ((d as BearableDay).symptoms?.length ?? 0) + 1,
        most: most.length ? `Most common factors: ${list(most)}.` : undefined,
        left: leftOut(p.skipped, ["row", "rows"]),
        rows: [
          ...(p.moods ? [{ ...moodRow, title: `${count(p.moods, "mood", "moods")}, for the days you haven't rated` }] : []),
          ...(p.habits.length ? [{ icon: "loop" as IconName, title: `${count(p.habits.length, "factor", "factors")} as habits`, meta: "Caffeine, a walk, a late night: each on its day" }] : []),
          ...(p.health_days ? [{ icon: "shield" as IconName, title: `Symptoms and energy on ${count(p.health_days, "day", "days")}`, meta: "Encrypted like your health data and kept out of Days" }] : []),
        ],
      };
    },
    done: (r) => {
      const extra = [...moodDone(r), r.health_days ? `Symptoms and energy for ${count(r.health_days, "day", "days")} are encrypted, like your health data.` : ""].filter(Boolean);
      return habitsDone(r, extra);
    },
  },
  overcast: {
    name: "Overcast",
    title: "Import your podcasts",
    accept: ".opml,.xml,text/xml,text/x-opml,application/xml",
    file: "overcast.opml",
    lede: "Overcast's website exports what you've played. Athena puts each episode under Listened, on the day you played it.",
    steps: [
      { title: "Sign in at overcast.fm", sub: "The app can't export, so this opens the website. Use the same sign-in as the app.", open: "https://overcast.fm/account" },
      { title: "Download “All data”", sub: "Under Export, choose the extended OPML. It's the one with your played episodes." },
      { title: "Add it here", sub: "Export again later for newer episodes: nothing is added twice." },
    ],
    privacy: "Athena reads the file on this device and sends only played episodes: show, title and link.",
    unit: ["episode", "episodes"],
    wrong: "That isn't Overcast's export. On overcast.fm, open your account and download the extended OPML (All data).",
    empty: "That file has your podcasts but no played episodes. Download the extended OPML (All data), not the plain one.",
    read: async (files) => {
      const p = parseOvercast(await readText(files[0], MAX_CSV_BYTES), { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, today: todayIso() });
      const shows = new Map<string, number>();
      for (const d of p.days) for (const e of d.episodes) shows.set(e.show, (shows.get(e.show) ?? 0) + 1);
      const most = top(shows);
      const partial = p.days.reduce((k, d) => k + d.episodes.filter((e) => e.partial).length, 0);
      return {
        days: p.days,
        items: p.episodes,
        headline: [p.episodes, plural(p.episodes, "episode", "episodes")],
        size: (d) => (d as PodcastDay).episodes.length,
        most: most.length ? `Most played: ${list(most)}.` : undefined,
        left: [partial ? `${count(partial, "episode is", "episodes are")} part played. ${plural(partial, "It comes", "They come")} over with the minutes you heard.` : "", ...leftOut(p.skipped, ["episode", "episodes"])].filter(Boolean),
        rows: [
          { icon: "mic", title: `${count(p.shows.length, "show", "shows")} under Listened`, meta: "Each episode on the day Overcast last saw it played" },
          { icon: "clock", title: p.minutes ? `${n(Math.round(p.minutes / 60))} hours with times` : "No listening times", meta: "Overcast only keeps the time for episodes you haven't finished" },
        ],
      };
    },
    done: (r) => ({
      title: r.added ? `Added ${count(r.added, "episode", "episodes")}` : "Nothing new to add",
      sub: r.added ? `Across ${count(r.days_created + r.days_updated, "day", "days")} in Days, under Listened.` : "Everything in this file is already in Days.",
      extra: [],
    }),
  },
  tfl: {
    name: "TfL",
    title: "Import your journeys",
    accept: ".csv,text/csv",
    file: "the journey history CSV",
    lede: "TfL lets you download the journeys on your Oyster or contactless card. Athena adds each one to the day you made it.",
    steps: [
      { title: "Sign in to your TfL account", sub: "Contactless and Oyster cards are both under your TfL account.", open: "https://contactless.tfl.gov.uk" },
      { title: "Open Journey history", sub: "Pick the card, then the weeks you want. TfL shows the last 8 weeks for Oyster and 12 months for contactless." },
      { title: "Download as CSV", sub: "Do it again for older weeks, or add the CSV from TfL's weekly email. Nothing is added twice." },
    ],
    privacy: "Athena reads the file on this device. Fares, top-ups and balances never leave it.",
    unit: ["journey", "journeys"],
    wrong: "That isn't a TfL journey history. In your TfL account, open Journey history and download it as CSV.",
    empty: "That file has no journeys, only top-ups or payments.",
    read: async (files) => {
      const texts = await Promise.all(files.map((f) => readText(f, MAX_CSV_BYTES)));
      const parses = texts.map((t) => parseTfl(t, { today: todayIso() }));
      // Several weeks' files as one: each day's journeys once.
      const by = new Map<string, JourneyDay>();
      for (const p of parses)
        for (const d of p.days) {
          const have = by.get(d.day);
          if (!have) by.set(d.day, { day: d.day, journeys: [...d.journeys] });
          else for (const j of d.journeys) if (!have.journeys.some((x) => x.title === j.title && x.start === j.start)) have.journeys.push(j);
        }
      const days = [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
      const journeys = days.reduce((k, d) => k + d.journeys.length, 0);
      const minutes = days.reduce((k, d) => k + d.journeys.reduce((m, j) => m + (j.minutes ?? 0), 0), 0);
      const stations = new Map<string, number>();
      for (const p of parses) p.top.forEach((s, i) => stations.set(s, (stations.get(s) ?? 0) + (5 - i)));
      const most = top(stations);
      const other = parses.reduce((k, p) => k + p.skipped.other, 0);
      return {
        days,
        items: journeys,
        headline: [journeys, plural(journeys, "journey", "journeys")],
        size: (d) => (d as JourneyDay).journeys.length,
        most: most.length ? `Most often: ${list(most)}.` : undefined,
        left: [
          other ? `${count(other, "row is", "rows are")} a top-up, refund or payment, so ${plural(other, "it's", "they're")} left out.` : "",
          ...leftOut({ undated: parses.reduce((k, p) => k + p.skipped.undated, 0), future: parses.reduce((k, p) => k + p.skipped.future, 0) }, ["journey", "journeys"]),
        ].filter(Boolean),
        rows: [
          { icon: "train", title: "Each journey goes into Days", meta: "Under Commute, with the time it took" },
          { icon: "clock", title: minutes ? `${n(Math.round(minutes / 60))} hours on the move` : "No journey times", meta: "From touching in to touching out. Buses have a start time only" },
        ],
      };
    },
    done: (r) => ({
      title: r.added ? `Added ${count(r.added, "journey", "journeys")}` : "Nothing new to add",
      sub: r.added ? `Across ${count(r.days_created + r.days_updated, "day", "days")} in Days, under Commute.` : "Everything in this file is already in Days.",
      extra: [],
    }),
  },
};

export const backfillSpec = (f: BackfillFormat) => SPECS[f];
export const BACKFILL_FORMATS = Object.keys(SPECS) as BackfillFormat[];
/** The import's memo id, as the server keeps it (import-routes.ts memoId). */
export const backfillMemoId = (f: BackfillFormat) => `file-${f}`;

/** The five busiest months, as bars: proof it's your history, and when you logged most. */
function busiestMonths(p: Parsed): HTMLElement | null {
  const perMonth = new Map<string, number>();
  for (const d of p.days) perMonth.set(d.day.slice(0, 7), (perMonth.get(d.day.slice(0, 7)) ?? 0) + p.size(d));
  if (perMonth.size < 3 || p.items < 20) return null;
  const top5 = [...perMonth.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, 5);
  const max = top5[0][1];
  return h(
    "figure",
    { class: "nfimp-months" },
    h("figcaption", { class: "group__label nfimp-months__label" }, "Busiest months"),
    h(
      "ol",
      { class: "nfimp-months__list", role: "list" },
      ...top5.map(([m, v], i) =>
        h(
          "li",
          { class: "nfimp-month", style: `--w:${Math.max(3, Math.round((v / max) * 100))}%; --i:${i}` },
          h("span", { class: "nfimp-month__name" }, monthYear(`${m}-15`)),
          h("span", { class: "nfimp-month__track", "aria-hidden": "true" }, h("span", { class: "nfimp-month__bar" })),
          h("span", { class: "nfimp-month__n" }, n(v))
        )
      )
    )
  );
}

/** `changed`: something was added, so Sources can say when. */
export function openBackfillImport(format: BackfillFormat, changed?: () => void): void {
  const spec = SPECS[format];
  const body = h("div", { class: "ytimp grimp nfimp bfimp" });
  const path = `/days/import/${format}`;
  let target: Target | null = null;
  let targetLoad: Promise<Target | null> | null = null;
  let abort: AbortController | null = null;
  let file: { items: number; days: number } | null = null;

  const sheet: SheetHandle = openSheet({
    label: spec.title,
    title: spec.title,
    body,
    onClose: () => {
      abort?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
    },
  });

  const loadTarget = () =>
    (targetLoad ??= request<Target>(path)
      .then((t) => (target = t))
      .catch(() => {
        targetLoad = null;
        return null;
      }));
  void loadTarget();

  const beforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };

  const show = (...children: Array<HTMLElement | null>) => {
    body.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
    body.scrollIntoView({ block: "start" });
  };

  // ---------- 1. How to get the file, and the picker ----------

  function stepsView(problem?: string) {
    sheet.setTitle(spec.title);
    sheet.setBack(null);
    const fine = matchMedia("(pointer: fine)").matches;
    const input = h("input", { type: "file", accept: spec.accept, multiple: format === "tfl", class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, "Choose the file") as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.length && void picked([...input.files]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, fine ? "Then drop the file here" : "Then choose the file here"),
      h("p", { class: "ytimp-drop__sub" }, h("span", { class: "ytimp-file" }, spec.file), format === "tfl" && fine ? ". Drop several weeks at once." : ", from your downloads."),
      problem ? h("p", { class: "ytimp-problem", role: "alert" }, icons.close(), h("span", {}, problem)) : null,
      choose,
      input
    );
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void picked(files);
    });

    show(
      h("div", { class: "bfimp-hero" }, backfillMark(format, "md"), h("p", { class: "ytimp__lede" }, spec.lede)),
      setupBlock({ steps: spec.steps }),
      drop,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, spec.privacy))
    );
    if (problem) {
      drop.classList.add("has-problem");
      drop.scrollIntoView({ block: "center" });
      choose.focus({ preventScroll: true });
    }
  }

  // ---------- 2. Reading it ----------

  async function picked(files: File[]) {
    sheet.setTitle("Reading your file");
    show(
      h(
        "div",
        { class: "ytimp-busy", role: "status" },
        h("span", { class: "meter meter--busy", "aria-hidden": "true" }, h("span", { class: "meter__fill" })),
        h("p", { class: "ytimp-busy__line" }, files.length === 1 ? `Reading ${files[0].name}…` : `Reading ${files.length} files…`)
      )
    );
    await new Promise((r) => setTimeout(r, 60));
    let parsed: Parsed;
    try {
      parsed = await spec.read(files);
    } catch (err) {
      // Too big: the file itself, or a zip over takeout-zip.ts's limits.
      if (err instanceof FileTooBig || (err instanceof Error && /too big/.test(err.message))) stepsView(TOO_BIG);
      else stepsView(err instanceof ImportFileError && err.reason === "empty" ? spec.empty : spec.wrong);
      return;
    }
    if (!parsed.days.length) {
      stepsView(spec.empty);
      return;
    }
    const t = target ?? (await loadTarget());
    if (!t) {
      stepsView("Athena can't be reached right now. Check you're online, then choose the file again.");
      return;
    }
    reviewView(parsed, t);
  }

  // ---------- 3. What's in it ----------

  function reviewView(p: Parsed, t: Target) {
    sheet.setTitle("Ready to add");
    sheet.setBack(() => stepsView());
    const first = p.days[0].day;
    const last = p.days[p.days.length - 1].day;
    const add = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Add to Days") as HTMLButtonElement;
    add.addEventListener("click", () => {
      file = { items: p.items, days: p.days.length };
      rememberImport(backfillMemoId(format), { at: new Date().toISOString(), ...file });
      void importView(p, t);
    });
    show(
      h(
        "section",
        { class: "ytimp-found" },
        h("p", { class: "ytimp-found__count" }, n(p.headline[0]), h("span", { class: "ytimp-found__unit" }, ` ${p.headline[1]}`)),
        h("p", { class: "ytimp-found__sub" }, first === last ? `On ${longDay(first)}.` : `From ${monthYear(first)} to ${longDay(last)}, across ${count(p.days.length, "day", "days")}.`),
        ...p.left.map((l) => h("p", { class: "ytimp-found__left" }, l))
      ),
      busiestMonths(p),
      p.most ? h("p", { class: "nfimp-most" }, p.most) : null,
      h(
        "div",
        { class: "card card--flush list ytimp-opts" },
        ...p.rows.map((r) =>
          h("div", { class: "row row--static" }, h("span", { class: "tile tile--sm" }, icons[r.icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, r.title), h("span", { class: "row__meta" }, r.meta)))
        )
      ),
      h("div", { class: "ytimp__actions" }, add, h("p", { class: "form__hint ytimp__again" }, "Run it again any time with a newer export. Nothing is added twice."))
    );
    add.focus({ preventScroll: true });
  }

  // ---------- 4. Adding it ----------

  async function importView(p: Parsed, t: Target, from = 0, carried?: BatchResult) {
    sheet.setTitle(spec.title);
    sheet.setBack(null);
    const batches = batchDays(p.days, p.size);
    const total = p.days.length;
    const totals: BatchResult = carried ?? { ...ZERO };
    const doneDays = (i: number) => batches.slice(0, i).reduce((k, b) => k + b.length, 0);

    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-label": "Days added so far" }, fill);
    const now = h("p", { class: "ytimp-run__now" });
    const counter = h("span", {});
    const stop = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Stop") as HTMLButtonElement;
    let stopped = false;
    stop.addEventListener("click", () => {
      stopped = true;
      stop.disabled = true;
      stop.textContent = "Stopping…";
      abort?.abort();
    });
    show(
      h("section", { class: "ytimp-run", "aria-live": "polite" }, now, meter, h("p", { class: "ytimp-run__meta" }, counter)),
      h("p", { class: "steps__note ytimp__keep" }, icons.clock(), h("span", {}, "Keep this open until it's done. If you stop, what's added stays.")),
      h("div", { class: "ytimp__actions" }, stop)
    );

    const paint = (i: number) => {
      const d = doneDays(i);
      fill.style.setProperty("--p", `${Math.max(2, Math.round((d / total) * 1000) / 10)}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(total)} days`);
      const next = batches[i];
      now.textContent = next ? `Adding ${monthYear(next[0].day)}` : "Finishing…";
      counter.textContent = `${n(d)} of ${count(total, "day", "days")}`;
    };

    window.addEventListener("beforeunload", beforeUnload);
    let i = from;
    try {
      for (; i < batches.length; i++) {
        paint(i);
        if (stopped) break;
        abort = new AbortController();
        const r = await request<BatchResult>(path, { method: "POST", body: JSON.stringify({ days: batches[i], file }), signal: abort.signal });
        for (const k of Object.keys(ZERO) as Array<keyof BatchResult>) totals[k] += r[k] ?? 0;
      }
      paint(i);
    } catch (err) {
      window.removeEventListener("beforeunload", beforeUnload);
      const lost = !(stopped || (err instanceof DOMException && err.name === "AbortError"));
      if (!lost && !body.isConnected) return;
      stoppedView(p, t, i, totals, lost, doneDays(i));
      return;
    }
    window.removeEventListener("beforeunload", beforeUnload);
    if (stopped && i < batches.length) stoppedView(p, t, i, totals, false, doneDays(i));
    else doneView(totals);
  }

  // ---------- 5. Stopped, or the connection went ----------

  function stoppedView(p: Parsed, t: Target, upTo: number, totals: BatchResult, lost: boolean, saved: number) {
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(p, t, upTo, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${count(p.days.length, "day", "days")} added` : "Nothing added yet"),
        h("p", { class: "ytimp-end__sub" }, lost ? "Carry on when you're back online. Nothing is added twice." : "What's added stays. Carry on now, or import the same file later: nothing is added twice.")
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 6. Done ----------

  function doneView(r: BatchResult) {
    sheet.setTitle(spec.title);
    const said = spec.done(r);
    const fresh = r.added > 0 || said.extra.length > 0;
    if (fresh) changed?.();
    const open = fresh ? h("a", { class: "btn btn--primary btn--block", href: "#/days" }, "Open Days") : h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    open.addEventListener("click", () => sheet.close());
    const extra = [...said.extra, r.days_skipped ? `On ${count(r.days_skipped, "day", "days")}, entries you'd hidden stayed hidden.` : ""].filter(Boolean);
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, said.title),
        h("p", { class: "ytimp-end__sub" }, said.sub),
        ...extra.map((e) => h("p", { class: "ytimp-end__extra" }, e))
      ),
      h("div", { class: "ytimp__actions" }, open)
    );
    open.focus({ preventScroll: true });
  }

  stepsView();
}
