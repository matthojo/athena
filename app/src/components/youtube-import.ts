/**
 * "Import watch history": YouTube watch history from a Google Takeout file,
 * into the Life log. Opened from a YouTube account's page in Sources.
 *
 * Steps to get the file, then a picker. The file is read here, on the
 * device (lib/youtube-takeout.ts; a zip is read in place by
 * lib/takeout-zip.ts), and only each day's videos (id, title, channel, how
 * many times) go to the server, a month or so per request. Progress shows as
 * it goes; Stop ends it between requests. Every request is safe to repeat,
 * so stopping, losing the connection or importing the same file again never
 * adds anything twice.
 */

import { FileTooBig, readText, TOO_BIG } from "../lib/file-limits";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { request } from "../db/api";
import { historyFromZip, isZip } from "../lib/takeout-zip";
import { rememberImport } from "../lib/youtube-import-memo";
import { batchDays, groupByDay, parseWatchHistory, TakeoutError, type TakeoutDay, type TakeoutParse } from "../../../lib/youtube-takeout";
import type { Connector } from "../types";
import "../styles/youtube-import.css";

interface Target {
  tz: string;
  collection: { id: string; name: string } | null;
  source: string;
}

interface BatchResult {
  days_created: number;
  days_updated: number;
  days_unchanged: number;
  days_skipped: number;
  added: number;
  added_tracks: number;
}

const n = (x: number) => x.toLocaleString("en-GB");

const monthYear = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "About 2 minutes left", once there's enough to go on. */
function eta(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return "";
  const s = Math.round(msLeft / 1000);
  if (s < 45) return "Less than a minute left";
  const m = Math.round(s / 60);
  return `About ${m} ${plural(m, "minute", "minutes")} left`;
}

const FILE_PROBLEM: Record<TakeoutError["reason"], string> = {
  unreadable: "That isn't a watch history file. In the Takeout download, open YouTube and YouTube Music, then history, and choose watch-history.json.",
  empty: "There are no videos in that file. Check that watch history was on in YouTube.",
  "not-found": "That zip has no watch history in it. If Google split your export into several zips, choose them all at once.",
  zip: "This browser can't open the zip. Unzip it first, then choose watch-history.json.",
};

/** The watch history in whichever of the picked files has it. */
async function readFiles(files: File[]): Promise<TakeoutParse> {
  let sawZip = false;
  for (const f of files) {
    if (await isZip(f)) {
      sawZip = true;
      let found;
      try {
        found = await historyFromZip(f);
      } catch {
        throw new TakeoutError("zip");
      }
      if (found) return parseWatchHistory(found.text);
      continue;
    }
    return parseWatchHistory(await readText(f));
  }
  throw new TakeoutError(sawZip ? "not-found" : "unreadable");
}

/** Videos per year, as a row of bars with the year under each. */
function yearStrip(days: TakeoutDay[]): HTMLElement {
  const perYear = new Map<string, number>();
  for (const d of days) {
    const y = d.day.slice(0, 4);
    perYear.set(y, (perYear.get(y) ?? 0) + d.videos.reduce((k, v) => k + (v.music ? 0 : v.count), 0));
  }
  const first = Number(days[0].day.slice(0, 4));
  const last = Number(days[days.length - 1].day.slice(0, 4));
  const years = Array.from({ length: last - first + 1 }, (_, i) => String(first + i));
  const max = Math.max(1, ...years.map((y) => perYear.get(y) ?? 0));
  const every = years.length > 10 ? 2 : 1;
  return h(
    "figure",
    { class: "ytimp-years", role: "img", "aria-label": `Videos per year: ${years.map((y) => `${y}, ${n(perYear.get(y) ?? 0)}`).join("; ")}` },
    h(
      "div",
      { class: "ytimp-years__bars", "aria-hidden": "true" },
      ...years.map((y) => {
        const v = perYear.get(y) ?? 0;
        return h("span", { class: "ytimp-years__bar", style: `--h:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%`, title: `${y}: ${n(v)} ${plural(v, "video", "videos")}` });
      })
    ),
    h(
      "div",
      { class: "ytimp-years__labels", "aria-hidden": "true" },
      ...years.map((y, i) => h("span", {}, i % every === 0 || i === years.length - 1 ? `’${y.slice(2)}` : ""))
    )
  );
}

/** `changed`: days were added, so the account page can say when. */
export function openYouTubeImport(account: Connector, changed?: () => void): void {
  const body = h("div", { class: "ytimp" });
  let target: Target | null = null;
  let targetLoad: Promise<Target | null> | null = null;
  let abort: AbortController | null = null;
  let wake: { release: () => Promise<void> } | null = null;
  /** What's in the file, for the server's "Imported 7 November · 39,251 videos". */
  let file: { items: number; days: number } | null = null;

  const sheet: SheetHandle = openSheet({
    label: "Import watch history",
    title: "Import watch history",
    body,
    onClose: () => {
      abort?.abort();
      stopGuard();
    },
  });

  const loadTarget = () =>
    (targetLoad ??= request<Target>(`/connectors/${encodeURIComponent(account.id)}/watch-history`)
      .then((t) => (target = t))
      .catch(() => {
        targetLoad = null;
        return null;
      }));
  void loadTarget();

  // While days are being added: keep the screen on, and ask before the page goes.
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
    sheet.setTitle("Import watch history");
    sheet.setBack(null);
    const input = h("input", { type: "file", accept: ".zip,.json,.html,application/zip,application/json,text/html", multiple: true, class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, "Choose the file") as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.length && void picked([...input.files]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, matchMedia("(pointer: fine)").matches ? "Then drop the file here" : "Then choose the file here"),
      h("p", { class: "ytimp-drop__sub" }, "The .zip Google sends, or ", h("span", { class: "ytimp-file" }, "watch-history.json"), " from inside it."),
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
      h("p", { class: "ytimp__lede" }, "YouTube doesn't share your watch history with other apps. Google Takeout can export it, and Athena puts each video on the day you watched it."),
      setupBlock({
        steps: [
          { title: "Open Google Takeout", sub: "Sign in with the account you use for YouTube.", open: "https://takeout.google.com/" },
          { title: "Choose only YouTube", sub: "Press Deselect all, then tick YouTube and YouTube Music." },
          { title: "Keep only history, as JSON", sub: "Under All YouTube data included, leave just history ticked. Under Multiple formats, set History to JSON." },
          { title: "Export and download it", sub: "Google emails you a link when it's ready, often within the hour." },
        ],
      }),
      drop,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, "Athena reads the file on this device and sends only each video's title, channel and link."))
    );
    if (problem) {
      drop.classList.add("has-problem");
      drop.scrollIntoView({ block: "center" });
      choose.focus({ preventScroll: true });
    }
  }

  // ---------- 2. Reading it ----------

  async function picked(files: File[]) {
    sheet.setTitle("Reading your history");
    show(
      h(
        "div",
        { class: "ytimp-busy", role: "status" },
        h("span", { class: "meter meter--busy", "aria-hidden": "true" }, h("span", { class: "meter__fill" })),
        h("p", { class: "ytimp-busy__line" }, files.length > 1 ? `Looking through ${files.length} files…` : `Reading ${files[0].name}…`)
      )
    );
    // Let the line paint before a big file holds the main thread.
    await new Promise((r) => setTimeout(r, 60));
    let parsed: TakeoutParse;
    try {
      parsed = await readFiles(files);
      if (!parsed.watches.length) throw new TakeoutError("empty");
    } catch (err) {
      stepsView(err instanceof FileTooBig ? TOO_BIG : err instanceof TakeoutError ? FILE_PROBLEM[err.reason] : FILE_PROBLEM.unreadable);
      return;
    }
    const t = target ?? (await loadTarget());
    if (!t) {
      stepsView("Athena can't be reached right now. Check you're online, then choose the file again.");
      return;
    }
    reviewView(parsed, groupByDay(parsed.watches, t.tz), t);
  }

  // ---------- 3. What's in it ----------

  function reviewView(parsed: TakeoutParse, days: TakeoutDay[], t: Target) {
    sheet.setTitle("Ready to add");
    sheet.setBack(() => stepsView());
    const videos = parsed.watches.filter((w) => !w.music).length;
    const tracks = parsed.watches.length - videos;
    const left = parsed.skipped.ads + parsed.skipped.removed;
    const counts = h("input", { type: "checkbox", role: "switch", class: "switch", checked: true, "aria-labelledby": "ytimp-count-title", "aria-describedby": "ytimp-count-sub" }) as HTMLInputElement;
    const add = h("button", { class: "btn btn--primary btn--block", type: "button" }, t.collection ? `Add to ${t.collection.name}` : "Add to your days") as HTMLButtonElement;
    add.addEventListener("click", () => {
      file = { items: videos, days: days.length };
      rememberImport(account.id, { at: new Date().toISOString(), ...file });
      void importView(days, t, counts.checked);
    });
    const first = days[0].day;
    const last = days[days.length - 1].day;

    show(
      h(
        "section",
        { class: "ytimp-found" },
        h("p", { class: "ytimp-found__count" }, n(videos), h("span", { class: "ytimp-found__unit" }, ` ${plural(videos, "video", "videos")}`)),
        h(
          "p",
          { class: "ytimp-found__sub" },
          `${monthYear(first) === monthYear(last) ? `In ${monthYear(first)}` : `From ${monthYear(first)} to ${monthYear(last)}`}, across ${n(days.length)} ${plural(days.length, "day", "days")}.`,
          tracks ? ` Also ${n(tracks)} ${plural(tracks, "track", "tracks")} played on YouTube Music.` : ""
        ),
        days.length > 1 && last.slice(0, 4) !== first.slice(0, 4) ? yearStrip(days) : null,
        left ? h("p", { class: "ytimp-found__left" }, `${n(left)} ${plural(left, "ad or removed video", "ads and removed videos")} left out.`) : null
      ),
      h(
        "div",
        { class: "card card--flush list ytimp-opts" },
        h(
          "div",
          { class: "row row--static" },
          h("span", { class: "tile tile--sm recipe-tile" }, icons.play()),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title" }, t.collection ? `Goes into ${t.collection.name}` : "Shows on your days"),
            h("span", { class: "row__meta" }, t.collection ? "Each video on its day, beside what's already there" : "Each video on its day. A Life log you set up later keeps them.")
          )
        ),
        h(
          "label",
          { class: "row row--static ytimp-opts__count" },
          h("span", { class: "tile tile--sm" }, icons.hash()),
          h("span", { class: "row__body" }, h("span", { class: "row__title", id: "ytimp-count-title" }, "Count videos per day"), h("span", { class: "row__meta", id: "ytimp-count-sub" }, "Fills Videos watched for each day")),
          counts
        )
      ),
      h("div", { class: "ytimp__actions" }, add, h("p", { class: "form__hint ytimp__again" }, "Safe to run again with a newer export: nothing is added twice."))
    );
    add.focus({ preventScroll: true });
  }

  // ---------- 4. Adding it ----------

  async function importView(days: TakeoutDay[], t: Target, metrics: boolean, from = 0, carried?: BatchResult) {
    sheet.setTitle("Adding your history");
    sheet.setBack(null);
    const batches = batchDays(days);
    const totals: BatchResult = carried ?? { days_created: 0, days_updated: 0, days_unchanged: 0, days_skipped: 0, added: 0, added_tracks: 0 };
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
      h(
        "section",
        { class: "ytimp-run", "aria-live": "polite" },
        now,
        meter,
        h("p", { class: "ytimp-run__meta" }, count, left)
      ),
      h("p", { class: "steps__note ytimp__keep" }, icons.clock(), h("span", {}, "Keep this open until it's done. If you stop, what's added stays.")),
      h("div", { class: "ytimp__actions" }, stop)
    );

    const paint = (i: number, started: number, startDone: number) => {
      const d = doneDays(i);
      fill.style.setProperty("--p", `${Math.round((d / days.length) * 1000) / 10}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(days.length)} days`);
      const next = batches[i];
      now.textContent = next ? `Adding ${monthYear(next[0].day)}` : "Finishing…";
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
        const r = await request<BatchResult>(`/connectors/${encodeURIComponent(account.id)}/watch-history`, {
          method: "POST",
          body: JSON.stringify({ days: batches[i], metrics, file }),
          signal: abort.signal,
        });
        for (const k of Object.keys(totals) as Array<keyof BatchResult>) totals[k] += r[k];
      }
      paint(i, started, startDone);
    } catch (err) {
      stopGuard();
      if (stopped || (err instanceof DOMException && err.name === "AbortError")) {
        if (!body.isConnected) return;
        stoppedView(days, t, metrics, i, totals, false);
        return;
      }
      stoppedView(days, t, metrics, i, totals, true);
      return;
    }
    stopGuard();
    if (stopped && i < batches.length) stoppedView(days, t, metrics, i, totals, false);
    else doneView(days.length, totals, t);
  }

  // ---------- 5. Stopped, or the connection went ----------

  function stoppedView(days: TakeoutDay[], t: Target, metrics: boolean, at: number, totals: BatchResult, lost: boolean) {
    const saved = batchDays(days).slice(0, at).reduce((k, b) => k + b.length, 0);
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(days, t, metrics, at, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${n(days.length)} days added` : "Nothing added yet"),
        h(
          "p",
          { class: "ytimp-end__sub" },
          lost ? "Carry on when you're back online. Nothing is added twice." : "What's added stays. Carry on now, or import the same file later: nothing is added twice."
        )
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 6. Done ----------

  function doneView(total: number, r: BatchResult, t: Target) {
    sheet.setTitle("Done");
    const fresh = r.added + r.added_tracks > 0;
    if (fresh) changed?.();
    const open = h("a", { class: "btn btn--primary btn--block", href: "#/days" }, "Open your days");
    open.addEventListener("click", () => sheet.close());
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    const days = r.days_created + r.days_updated;
    const extra = [
      fresh && r.days_unchanged ? `${n(r.days_unchanged)} ${plural(r.days_unchanged, "day was", "days were")} already up to date.` : "",
      r.days_skipped ? `${n(r.days_skipped)} ${plural(r.days_skipped, "day", "days")} you'd archived or deleted ${plural(r.days_skipped, "was", "were")} left alone.` : "",
    ].filter(Boolean);
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, !fresh ? "Nothing new to add" : r.added ? `Added ${n(r.added)} ${plural(r.added, "video", "videos")}` : `Added ${n(r.added_tracks)} ${plural(r.added_tracks, "track", "tracks")}`),
        h(
          "p",
          { class: "ytimp-end__sub" },
          !fresh
            ? `All ${n(total)} ${plural(total, "day", "days")} in this file ${plural(total, "is", "are")} already on your days.`
            : `${days === 1 ? "On" : "Across"} ${n(days)} of your days${r.added && r.added_tracks ? `, with ${n(r.added_tracks)} YouTube Music ${plural(r.added_tracks, "track", "tracks")}` : ""}.`
        ),
        ...extra.map((e) => h("p", { class: "ytimp-end__extra" }, e))
      ),
      h("div", { class: "ytimp__actions" }, open, close)
    );
    open.focus({ preventScroll: true });
  }

  stepsView();
}
