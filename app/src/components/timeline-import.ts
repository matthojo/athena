/**
 * "Import your Timeline": where you went, from a Google Maps Timeline file,
 * into the Life log's Places line. Opened from the Places page and from a
 * Swarm account's page.
 *
 * Steps to export the file from the phone, then a picker. The file is read
 * here, on the device (lib/places-timeline.ts; a Takeout zip is read in
 * place), and only each visit (start, end, the spot, Google's place id or
 * name, Home or Work) goes to the server, a month at a time. Then the
 * places are named (OpenStreetMap, one a second) while the sheet stays open;
 * closing it leaves the rest for the nightly run. Every request is safe to
 * repeat, so stopping or importing the same file again adds nothing twice.
 */

import { MAX_FILE_BYTES, TOO_BIG } from "../lib/file-limits";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { localToday } from "../lib/time";
import { addDays } from "../../../lib/dates";
import { request } from "../db/api";
import { entriesFromZip, isZip } from "../lib/takeout-zip";
import { batchVisitDays, groupVisitsByDay, mergeParses, parseTimeline, PHONE_FILE, TAKEOUT_MONTH, TimelineError, type TimelineDay, type TimelineParse } from "../../../lib/places-timeline";
import "../styles/youtube-import.css";
import "../styles/places.css";

export interface PlacesStatus {
  days: number;
  first: string | null;
  last: string | null;
  waiting: number;
  places: number;
  life_log: string | null;
  life_log_source: string;
  swarm: boolean;
  tz: string;
  latest: { date: string; lines: string[] } | null;
}

interface BatchResult {
  days: number;
  added: number;
  unchanged: number;
  skipped: number;
  new_places: number;
  waiting: number;
}

interface NamesResult {
  lookups: number;
  days: number;
  waiting: number;
  busy?: boolean;
}

const n = (x: number) => x.toLocaleString("en-GB");
const monthYear = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function eta(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return "";
  const s = Math.round(msLeft / 1000);
  if (s < 45) return "Less than a minute left";
  const m = Math.round(s / 60);
  if (m < 90) return `About ${m} ${plural(m, "minute", "minutes")} left`;
  const hrs = Math.round(m / 60);
  return `About ${hrs} hours left`;
}

type Problem = TimelineError["code"] | "zip" | "not_found" | "offline" | "too_big";
const FILE_PROBLEM: Record<Problem, string> = {
  not_timeline: "That isn't a Timeline file. Export Timeline data from Google Maps on your phone, then choose Timeline.json.",
  raw_records: "That's Google's raw location history. Choose the files in Semantic Location History instead, or export Timeline from your phone.",
  empty: "There are no visits in that file. Check that Timeline is on in Google Maps.",
  bad_json: "That file didn't open. Export it again from Google Maps, then choose it here.",
  zip: "This browser can't open the zip. Unzip it first, then choose the files in Semantic Location History.",
  not_found: "That zip has no Timeline in it. In Takeout, choose Location History (Timeline).",
  offline: "Athena can't be reached right now. Check you're online, then choose the file again.",
  too_big: TOO_BIG,
};

class FileProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem);
  }
}

/** Every picked file: the phone's Timeline.json, Takeout's monthly files, or a Takeout zip holding them. */
async function readFiles(files: File[]): Promise<TimelineParse> {
  const parses: TimelineParse[] = [];
  let sawZip = false;
  let firstError: Problem | null = null;
  for (const f of files) {
    if (await isZip(f)) {
      sawZip = true;
      let found;
      try {
        found = await entriesFromZip(f, new RegExp(`${TAKEOUT_MONTH.source}|${PHONE_FILE.source}`, "i"));
      } catch {
        throw new FileProblem("zip");
      }
      for (const e of found) {
        try {
          parses.push(parseTimeline(e.text));
        } catch {
          // A stray file in the folder: the rest still count.
        }
      }
      continue;
    }
    if (f.size > MAX_FILE_BYTES) throw new FileProblem("too_big");
    try {
      parses.push(parseTimeline(await f.text()));
    } catch (err) {
      firstError ??= err instanceof TimelineError ? err.code : "not_timeline";
    }
  }
  if (!parses.length) throw new FileProblem(firstError ?? (sawZip ? "not_found" : "not_timeline"));
  const merged = mergeParses(parses);
  if (!merged.visits.length) throw new FileProblem("empty");
  return merged;
}

/** Visits per year, as a row of bars with the year under each. */
function yearStrip(days: TimelineDay[]): HTMLElement {
  const perYear = new Map<string, number>();
  for (const d of days) perYear.set(d.date.slice(0, 4), (perYear.get(d.date.slice(0, 4)) ?? 0) + d.visits.length);
  const first = Number(days[0].date.slice(0, 4));
  const last = Number(days[days.length - 1].date.slice(0, 4));
  const years = Array.from({ length: last - first + 1 }, (_, i) => String(first + i));
  const max = Math.max(1, ...years.map((y) => perYear.get(y) ?? 0));
  const every = years.length > 10 ? 2 : 1;
  return h(
    "figure",
    { class: "ytimp-years", role: "img", "aria-label": `Visits per year: ${years.map((y) => `${y}, ${n(perYear.get(y) ?? 0)}`).join("; ")}` },
    h(
      "div",
      { class: "ytimp-years__bars", "aria-hidden": "true" },
      ...years.map((y) => {
        const v = perYear.get(y) ?? 0;
        return h("span", { class: "ytimp-years__bar", style: `--h:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%`, title: `${y}: ${n(v)} ${plural(v, "visit", "visits")}` });
      })
    ),
    h("div", { class: "ytimp-years__labels", "aria-hidden": "true" }, ...years.map((y, i) => h("span", {}, i % every === 0 || i === years.length - 1 ? `’${y.slice(2)}` : "")))
  );
}

/** `changed`: days were added, so the page that opened this can refresh. */
export function openTimelineImport(changed?: () => void): void {
  const body = h("div", { class: "ytimp tlimp" });
  let status: PlacesStatus | null = null;
  let statusLoad: Promise<PlacesStatus | null> | null = null;
  let abort: AbortController | null = null;
  let wake: { release: () => Promise<void> } | null = null;
  let touched = false;

  const sheet: SheetHandle = openSheet({
    label: "Import your Timeline",
    title: "Import your Timeline",
    body,
    onClose: () => {
      abort?.abort();
      stopGuard();
      if (touched) changed?.();
    },
  });

  const loadStatus = () =>
    (statusLoad ??= request<PlacesStatus>("/places/status")
      .then((s) => (status = s))
      .catch(() => {
        statusLoad = null;
        return null;
      }));
  void loadStatus();

  const beforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  function startGuard() {
    window.addEventListener("beforeunload", beforeUnload);
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock
      ?.request("screen")
      .then((w) => (wake = w))
      .catch(() => undefined);
  }
  function stopGuard() {
    window.removeEventListener("beforeunload", beforeUnload);
    void wake?.release().catch(() => undefined);
    wake = null;
  }

  const show = (...children: Array<HTMLElement | null>) => {
    body.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
    body.scrollIntoView({ block: "start" });
  };

  // ---------- 1. How to get the file, and the picker ----------

  function stepsView(problem?: string) {
    sheet.setTitle("Import your Timeline");
    sheet.setBack(null);
    const input = h("input", { type: "file", accept: ".json,.zip,application/json,application/zip", multiple: true, class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, "Choose the file") as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.length && void picked([...input.files]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, matchMedia("(pointer: fine)").matches ? "Then drop the file here" : "Then choose the file here"),
      h("p", { class: "ytimp-drop__sub" }, h("span", { class: "ytimp-file" }, "Timeline.json"), " from your phone. An older Takeout export works too."),
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
      h("p", { class: "ytimp__lede" }, "Google Maps keeps your Timeline on your phone. Export it once, and each of your days gets a line saying where you went."),
      h("div", { class: "tlimp-example", "aria-label": "For example" }, h("span", { class: "tlimp-example__label" }, "Each day, like this"), h("span", { class: "tlimp-example__line" }, "Lunch at Dishoom, then Hampstead Heath"), h("span", { class: "tlimp-example__weather" }, "14° and rain in London")),
      setupBlock({
        steps: [
          { title: "Export it from your phone", sub: "iPhone: in Google Maps, tap your picture, then Settings, Personal content, Export Timeline data. Android: Settings, Location, Location services, Timeline, Export Timeline data." },
          { title: "Get the file here", sub: "Save Timeline.json somewhere this device can open: Files, Google Drive, or AirDrop to your Mac." },
        ],
      }),
      drop,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, "Athena reads the file on this device. It sends only when and where you stopped, and stores that encrypted."))
    );
    if (problem) {
      drop.classList.add("has-problem");
      drop.scrollIntoView({ block: "center" });
      choose.focus({ preventScroll: true });
    }
  }

  // ---------- 2. Reading it ----------

  async function picked(files: File[]) {
    sheet.setTitle("Reading your Timeline");
    show(
      h(
        "div",
        { class: "ytimp-busy", role: "status" },
        h("span", { class: "meter meter--busy", "aria-hidden": "true" }, h("span", { class: "meter__fill" })),
        h("p", { class: "ytimp-busy__line" }, files.length > 1 ? `Looking through ${n(files.length)} files…` : `Reading ${files[0].name}…`)
      )
    );
    await new Promise((r) => setTimeout(r, 60));
    let parsed: TimelineParse;
    try {
      parsed = await readFiles(files);
    } catch (err) {
      stepsView(FILE_PROBLEM[err instanceof FileProblem ? err.problem : "not_timeline"]);
      return;
    }
    const s = status ?? (await loadStatus());
    if (!s) {
      stepsView(FILE_PROBLEM.offline);
      return;
    }
    reviewView(parsed, groupVisitsByDay(parsed.visits, s.tz), s);
  }

  // ---------- 3. What's in it ----------

  function reviewView(parsed: TimelineParse, days: TimelineDay[], s: PlacesStatus) {
    sheet.setTitle("Ready to add");
    sheet.setBack(() => stepsView());
    const visits = parsed.visits.length;
    const add = h("button", { class: "btn btn--primary btn--block", type: "button" }, s.life_log ? `Add to ${s.life_log}` : "Add to your days") as HTMLButtonElement;
    add.addEventListener("click", () => void importView(days));
    const first = days[0].date;
    const last = days[days.length - 1].date;
    show(
      h(
        "section",
        { class: "ytimp-found" },
        h("p", { class: "ytimp-found__count" }, n(visits), h("span", { class: "ytimp-found__unit" }, ` ${plural(visits, "visit", "visits")}`)),
        h("p", { class: "ytimp-found__sub" }, days.length === 1 ? `On ${longDay(first)}.` : `From ${monthYear(first)} to ${longDay(last)}, across ${n(days.length)} days.`),
        days.length > 1 && last.slice(0, 4) !== first.slice(0, 4) ? yearStrip(days) : null
      ),
      h(
        "div",
        { class: "card card--flush list ytimp-opts" },
        h(
          "div",
          { class: "row row--static" },
          h("span", { class: "tile tile--sm recipe-tile" }, icons.notes()),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title" }, s.life_log ? `Goes into ${s.life_log}` : "Shows on your days"),
            h("span", { class: "row__meta" }, s.life_log ? "One line a day, with the weather" : "One line a day. A Life log you set up later keeps them.")
          )
        ),
        h(
          "div",
          { class: "row row--static" },
          h("span", { class: "tile tile--sm" }, icons.pin()),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Places you went become Places"), h("span", { class: "row__meta" }, "Each one shows when you've been"))
        )
      ),
      h("div", { class: "ytimp__actions" }, add, h("p", { class: "form__hint ytimp__again" }, "Safe to run again with a newer export: nothing is added twice."))
    );
    add.focus({ preventScroll: true });
  }

  // ---------- 4. Adding it ----------

  async function importView(days: TimelineDay[], from = 0, carried?: BatchResult) {
    sheet.setTitle("Adding your Timeline");
    sheet.setBack(null);
    const batches = batchVisitDays(days);
    const totals: BatchResult = carried ?? { days: 0, added: 0, unchanged: 0, skipped: 0, new_places: 0, waiting: 0 };
    const doneDays = (i: number) => batches.slice(0, i).reduce((k, b) => k + b.length, 0);
    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(days.length), "aria-label": "Days added" }, fill);
    const now = h("p", { class: "ytimp-run__now" });
    const count = h("span", {});
    const left = h("span", {});
    const stop = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Stop") as HTMLButtonElement;
    let stopped = false;
    stop.addEventListener("click", () => {
      stopped = true;
      stop.disabled = true;
      stop.textContent = "Stopping…";
      abort?.abort();
    });
    show(
      h("section", { class: "ytimp-run", "aria-live": "polite" }, now, meter, h("p", { class: "ytimp-run__meta" }, count, left)),
      h("p", { class: "steps__note ytimp__keep" }, icons.clock(), h("span", {}, "Keep this open until it's done. If you stop, what's added stays.")),
      h("div", { class: "ytimp__actions" }, stop)
    );
    const paint = (i: number, started: number, startDone: number) => {
      const d = doneDays(i);
      fill.style.setProperty("--p", `${Math.round((d / days.length) * 1000) / 10}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(days.length)} days`);
      const next = batches[i];
      now.textContent = next ? `Adding ${monthYear(next[0].date)}` : "Finishing…";
      count.textContent = `${n(d)} of ${n(days.length)} ${plural(days.length, "day", "days")}`;
      const per = (performance.now() - started) / Math.max(1, d - startDone);
      left.textContent = d - startDone >= 30 ? eta(per * (days.length - d)) : "";
    };
    startGuard();
    const started = performance.now();
    const startDone = doneDays(from);
    let i = from;
    try {
      for (; i < batches.length; i++) {
        paint(i, started, startDone);
        if (stopped) break;
        abort = new AbortController();
        const r = await request<BatchResult>("/places/timeline", { method: "POST", body: JSON.stringify({ days: batches[i] }), signal: abort.signal });
        touched = true;
        for (const k of ["days", "added", "unchanged", "skipped", "new_places"] as const) totals[k] += r[k];
        totals.waiting = r.waiting;
      }
      paint(i, started, startDone);
    } catch (err) {
      stopGuard();
      const aborted = stopped || (err instanceof DOMException && err.name === "AbortError");
      if (aborted && !body.isConnected) return;
      stoppedView(days, i, totals, !aborted);
      return;
    }
    stopGuard();
    if (stopped && i < batches.length) stoppedView(days, i, totals, false);
    else if (totals.waiting > 0) void namingView(days.length, totals);
    else doneView(days.length, totals);
  }

  // ---------- 5. Naming the places ----------

  async function namingView(total: number, totals: BatchResult) {
    sheet.setTitle("Naming your places");
    sheet.setBack(null);
    const startWaiting = Math.max(1, totals.waiting);
    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(startWaiting), "aria-label": "Days named" }, fill);
    const line = h("p", { class: "ytimp-run__now" }, "Looking up places");
    const count = h("span", {});
    const left = h("span", {});
    const later = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Finish tonight instead") as HTMLButtonElement;
    let leave = false;
    later.addEventListener("click", () => {
      leave = true;
      later.disabled = true;
      abort?.abort();
    });
    show(
      h("section", { class: "ytimp-run", "aria-live": "polite" }, line, meter, h("p", { class: "ytimp-run__meta" }, count, left)),
      h("p", { class: "steps__note ytimp__keep" }, icons.clock(), h("span", {}, "Your Timeline has the spot but not its name, so Athena asks OpenStreetMap, one place a second. Close this and it carries on tonight.")),
      h("div", { class: "ytimp__actions" }, later)
    );
    startGuard();
    const started = performance.now();
    let waiting = totals.waiting;
    let quiet = 0;
    const paint = () => {
      const done = Math.max(0, startWaiting - waiting);
      fill.style.setProperty("--p", `${Math.round((done / startWaiting) * 1000) / 10}%`);
      meter.setAttribute("aria-valuenow", String(done));
      count.textContent = waiting ? `${n(waiting)} ${plural(waiting, "day", "days")} to go` : "Finishing…";
      const per = (performance.now() - started) / Math.max(1, done);
      left.textContent = done >= 3 ? eta(per * waiting) : "";
    };
    paint();
    try {
      while (waiting > 0 && !leave) {
        abort = new AbortController();
        const r = await request<NamesResult>("/places/names", { method: "POST", body: "{}", signal: abort.signal });
        // Nothing moved twice in a row (OpenStreetMap is busy): leave the rest for tonight.
        quiet = r.lookups || r.waiting < waiting ? 0 : quiet + 1;
        waiting = r.waiting;
        paint();
        if (quiet >= 2) break;
      }
    } catch {
      // Offline or stopped: what's named stays named, and tonight's run carries on.
    }
    stopGuard();
    totals.waiting = waiting;
    if (!body.isConnected) return;
    doneView(total, totals);
  }

  // ---------- 6. Stopped, or the connection went ----------

  function stoppedView(days: TimelineDay[], at: number, totals: BatchResult, lost: boolean) {
    const saved = batchVisitDays(days).slice(0, at).reduce((k, b) => k + b.length, 0);
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(days, at, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${n(days.length)} days added` : "Nothing added yet"),
        h("p", { class: "ytimp-end__sub" }, lost ? "Carry on when you're back online. Nothing is added twice." : "What's added stays. Carry on now, or import the same file later: nothing is added twice.")
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 7. Done ----------

  async function doneView(total: number, r: BatchResult) {
    sheet.setTitle("Done");
    const fresh = r.added > 0;
    const s = await request<PlacesStatus>("/places/status").catch(() => status);
    if (!body.isConnected) return;
    const open = h("a", { class: "btn btn--primary btn--block", href: "#/days" }, "Open your days");
    open.addEventListener("click", () => sheet.close());
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    const days = r.days - r.unchanged;
    const extra = [
      r.new_places ? `${n(r.new_places)} new ${plural(r.new_places, "place", "places")} in Places.` : "",
      r.waiting ? `${n(r.waiting)} ${plural(r.waiting, "day is", "days are")} still being named. Athena carries on tonight.` : "",
      fresh && r.unchanged ? `${n(r.unchanged)} ${plural(r.unchanged, "day was", "days were")} already up to date.` : "",
      r.skipped ? `${n(r.skipped)} ${plural(r.skipped, "day", "days")} you'd archived or deleted ${plural(r.skipped, "was", "were")} left alone.` : "",
    ].filter(Boolean);
    const latest = s?.latest;
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, fresh ? `Added ${n(r.added)} ${plural(r.added, "visit", "visits")}` : "Nothing new to add"),
        h("p", { class: "ytimp-end__sub" }, fresh ? `${days === 1 ? "On" : "Across"} ${n(days)} of your days.` : `All ${n(total)} ${plural(total, "day", "days")} in this file ${plural(total, "is", "are")} already there.`),
        ...extra.map((e) => h("p", { class: "ytimp-end__extra" }, e))
      ),
      latest && fresh ? dayPreview(latest) : null,
      h("div", { class: "ytimp__actions" }, open, close)
    );
    open.focus({ preventScroll: true });
  }

  stepsView();
}

/** "Tuesday 3 November" and its Places lines, as the day note shows them. */
export function dayPreview(latest: { date: string; lines: string[] }): HTMLElement {
  const long = new Date(`${latest.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const day = latest.date === addDays(localToday(), -1) ? `Yesterday · ${long}` : long;
  return h(
    "div",
    { class: "tlimp-example tlimp-example--day" },
    h("span", { class: "tlimp-example__label" }, day),
    h("span", { class: "tlimp-example__line" }, latest.lines[0]),
    latest.lines[1] ? h("span", { class: "tlimp-example__weather" }, latest.lines[1]) : null
  );
}
