/**
 * "Import your viewing history": what you watched on Netflix, from the file
 * its Viewing activity page downloads (one per profile), into the Life log on
 * the day you watched each film and episode, and into Watch & read. Opened
 * from a Netflix account's page in Sources, or straight after adding one.
 *
 * Same shape as the Goodreads and YouTube imports (whose styles it shares):
 * steps to get the file, a picker, what's in it, progress, done. The file is
 * read here, on the device (lib/netflix-csv.ts), and only title parts and
 * days go to the server. Every request is safe to repeat, so stopping,
 * losing the connection, importing the same file again or another profile's
 * file never adds anything twice.
 */

import { MAX_CSV_BYTES, TOO_BIG } from "../lib/file-limits";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { request } from "../db/api";
import { rememberImport } from "../lib/youtube-import-memo";
import {
  batchNetflixDays,
  countWatched,
  groupViewsByDay,
  NetflixError,
  parseViewingActivity,
  type DateOrder,
  type NetflixDay,
  type NetflixParse,
  type Viewing,
} from "../../../lib/netflix-csv";
import type { Connector } from "../types";
import "../styles/youtube-import.css";
import "../styles/goodreads-import.css";
import "../styles/netflix-import.css";

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
  added_films: number;
  watch_read: { created: number; updated: number };
}

const TITLE = "Import your viewing history";
const n = (x: number) => x.toLocaleString("en-GB");
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const monthYear = (day: string) => at(day).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => at(day).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "1,240 episodes and 38 films", "1 film", "12 episodes". */
function watchedText(episodes: number, films: number): string {
  const e = episodes ? `${n(episodes)} ${plural(episodes, "episode", "episodes")}` : "";
  const f = films ? `${n(films)} ${plural(films, "film", "films")}` : "";
  return [e, f].filter(Boolean).join(" and ");
}

/** "160 shows and 38 films", "1 show", "2 films": one Watch & read item each. */
function titlesText(shows: number, films: number): string {
  return [shows ? `${n(shows)} ${plural(shows, "show", "shows")}` : "", films ? `${n(films)} ${plural(films, "film", "films")}` : ""].filter(Boolean).join(" and ");
}

const FILE_PROBLEM: Record<NetflixError["reason"] | "mixed" | "undated" | "offline", string> = {
  unreadable: "That isn't a Netflix viewing history. On Netflix's Viewing activity page, press Download all and choose the file it saves.",
  empty: "There's nothing in that file. Check you downloaded it from the profile you watch on.",
  "full-export": "That file is from Netflix's full data download. Use the one from Viewing activity instead: press Download all there.",
  mixed: "Those files write dates in different ways. Choose them one at a time.",
  undated: "Athena couldn't read the dates in that file. Download it again from Netflix, then choose the new file.",
  offline: "Athena can't be reached right now. Check you're online, then choose the file again.",
};

/** The five busiest months, as bars: proof it's your history, and when you watched most. */
function busiestMonths(views: Viewing[]): HTMLElement | null {
  const perMonth = new Map<string, number>();
  for (const v of views) perMonth.set(v.day.slice(0, 7), (perMonth.get(v.day.slice(0, 7)) ?? 0) + 1);
  // A few months of a handful each says nothing: the sentence above is enough.
  if (perMonth.size < 3 || views.length < 20) return null;
  const top = [...perMonth.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, 5);
  const max = top[0][1];
  const name = (m: string) => monthYear(`${m}-15`);
  return h(
    "figure",
    { class: "nfimp-months" },
    h("figcaption", { class: "group__label nfimp-months__label" }, "Busiest months"),
    h(
      "ol",
      { class: "nfimp-months__list", role: "list" },
      ...top.map(([m, v], i) =>
        h(
          "li",
          { class: "nfimp-month", style: `--w:${Math.max(3, Math.round((v / max) * 100))}%; --i:${i}` },
          h("span", { class: "nfimp-month__name" }, name(m)),
          h("span", { class: "nfimp-month__track", "aria-hidden": "true" }, h("span", { class: "nfimp-month__bar" })),
          h("span", { class: "nfimp-month__n" }, n(v))
        )
      )
    )
  );
}

/** "Most watched: Slow Horses, The Crown and Friends." */
function mostWatched(views: Viewing[]): string {
  const per = new Map<string, number>();
  for (const v of views) if (v.season !== undefined) per.set(v.title, (per.get(v.title) ?? 0) + 1);
  const top = [...per.entries()].sort((a, b) => b[1] - a[1]).filter(([, k]) => k >= 3).slice(0, 3).map(([t]) => t);
  if (!top.length) return "";
  return `Most watched: ${top.length === 1 ? top[0] : `${top.slice(0, -1).join(", ")} and ${top[top.length - 1]}`}.`;
}

/** Several profiles' files as one: views together, oldest first. */
function combine(parses: NetflixParse[]): NetflixParse {
  const views = parses.flatMap((p) => p.views).sort((a, b) => a.day.localeCompare(b.day));
  return {
    views,
    order: parses[0].order,
    guessed: parses.some((p) => p.guessed),
    skipped: { undated: parses.reduce((k, p) => k + p.skipped.undated, 0), future: parses.reduce((k, p) => k + p.skipped.future, 0) },
  };
}

/** `changed`: something was added, so the account page can say when. */
export function openNetflixImport(account: Connector, changed?: () => void): void {
  const body = h("div", { class: "ytimp grimp nfimp" });
  const path = `/connectors/${encodeURIComponent(account.id)}/viewing`;
  let target: Target | null = null;
  let targetLoad: Promise<Target | null> | null = null;
  let abort: AbortController | null = null;
  let file: { items: number; days: number } | null = null;

  const sheet: SheetHandle = openSheet({
    label: TITLE,
    title: TITLE,
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

  const lifeLog = (t: Target) => t.collection?.name ?? "Life log";

  // ---------- 1. How to get the file, and the picker ----------

  function stepsView(problem?: string, another = false) {
    sheet.setTitle(TITLE);
    sheet.setBack(null);
    const fine = matchMedia("(pointer: fine)").matches;
    const input = h("input", { type: "file", accept: ".csv,text/csv", multiple: true, class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, another ? "Choose the next file" : "Choose the file") as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.length && void picked([...input.files]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, another ? "Add another profile's file" : fine ? "Then drop the file here" : "Then choose the file here"),
      h("p", { class: "ytimp-drop__sub" }, h("span", { class: "ytimp-file" }, "NetflixViewingHistory.csv"), fine ? ". Drop several at once for more profiles." : ", from your downloads."),
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
      another
        ? h("p", { class: "ytimp__lede" }, "On Netflix, switch to the other profile, open Viewing activity and press Download all. Then add that file here.")
        : h("p", { class: "ytimp__lede" }, "Netflix doesn't share what you watch with other apps, but you can download it. Athena puts each film and episode on the day you watched it."),
      another
        ? null
        : setupBlock({
            steps: [
              { title: "Open Viewing activity", sub: "Sign in and pick your profile. The Netflix app can't download it, so this opens the website.", open: "https://www.netflix.com/viewingactivity" },
              { title: "Press Download all", sub: "It's at the bottom of the list. Netflix saves the file to your downloads." },
              { title: "One file per profile", sub: "Each profile has its own history. Download each one you watch on and add them all here." },
            ],
          }),
      drop,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, "Athena reads the file on this device and sends only the titles and dates."))
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
        h("p", { class: "ytimp-busy__line" }, files.length === 1 ? `Reading ${files[0].name}…` : `Reading ${files.length} files…`)
      )
    );
    await new Promise((r) => setTimeout(r, 60));
    if (files.some((f) => f.size > MAX_CSV_BYTES)) {
      stepsView(TOO_BIG);
      return;
    }
    const texts = await Promise.all(files.map((f) => f.text()));
    read(texts);
  }

  function read(texts: string[], order?: DateOrder) {
    let parses: NetflixParse[];
    try {
      parses = texts.map((t) => parseViewingActivity(t, { locale: navigator.language, order, today: todayIso() }));
    } catch (err) {
      stepsView(FILE_PROBLEM[err instanceof NetflixError ? err.reason : "unreadable"]);
      return;
    }
    if (!order && new Set(parses.filter((p) => !p.guessed).map((p) => p.order)).size > 1) {
      stepsView(FILE_PROBLEM.mixed);
      return;
    }
    const parsed = combine(parses);
    if (!parsed.views.length) {
      stepsView(FILE_PROBLEM.undated);
      return;
    }
    void (async () => {
      const t = target ?? (await loadTarget());
      if (!t) {
        stepsView(FILE_PROBLEM.offline);
        return;
      }
      // Flipped once means it was open to doubt: keep offering the other way.
      reviewView(texts, parsed, t, texts.length, parsed.guessed || order !== undefined);
    })();
  }

  // ---------- 3. What's in it ----------

  function reviewView(texts: string[], parsed: NetflixParse, t: Target, files: number, ambiguous: boolean) {
    sheet.setTitle("Ready to add");
    sheet.setBack(() => stepsView());
    const days = groupViewsByDay(parsed.views);
    const { episodes, films } = countWatched(days);
    const total = episodes + films;
    const first = days[0].day;
    const last = days[days.length - 1].day;
    const shows = new Set(parsed.views.filter((v) => v.season !== undefined).map((v) => v.title)).size;
    const filmTitles = new Set(parsed.views.filter((v) => v.season === undefined).map((v) => v.title)).size;

    const add = h("button", { class: "btn btn--primary btn--block", type: "button" }, `Add to ${lifeLog(t)}`) as HTMLButtonElement;
    add.addEventListener("click", () => {
      file = { items: total, days: days.length };
      rememberImport(account.id, { at: new Date().toISOString(), ...file });
      void importView(days, t, total);
    });

    // A file whose dates could be either way round asks, in dates, which way: "3/4" is 3 April or 4 March.
    const choice = (order: DateOrder, label: string) => {
      const b = h("button", { class: "chip nfimp-choice", type: "button", role: "radio", "aria-checked": String(parsed.order === order) }, label);
      b.addEventListener("click", () => parsed.order !== order && read(texts, order));
      return b;
    };
    const dateQuestion = h(
      "div",
      { class: "nfimp-dates" },
      h("p", { class: "nfimp-dates__q", id: "nfimp-dates-q" }, "Netflix wrote 3/4. Is that…"),
      h("div", { class: "nfimp-dates__opts", role: "radiogroup", "aria-labelledby": "nfimp-dates-q" }, choice("dmy", "3 April"), choice("mdy", "4 March"))
    );

    const { undated, future } = parsed.skipped;
    const most = mostWatched(parsed.views);
    show(
      h(
        "section",
        { class: "ytimp-found" },
        h("p", { class: "ytimp-found__count" }, n(episodes || films), h("span", { class: "ytimp-found__unit" }, ` ${episodes ? plural(episodes, "episode", "episodes") : plural(films, "film", "films")}`)),
        h(
          "p",
          { class: "ytimp-found__sub" },
          episodes && films ? `And ${n(films)} ${plural(films, "film", "films")}. ` : "",
          first === last ? `On ${longDay(first)}.` : `${monthYear(first) === monthYear(last) ? `In ${monthYear(first)}` : `From ${monthYear(first)} to ${monthYear(last)}`}, across ${n(days.length)} ${plural(days.length, "day", "days")}.`,
          files > 1 ? ` From ${n(files)} profiles.` : ""
        ),
        undated ? h("p", { class: "ytimp-found__left" }, `${n(undated)} ${plural(undated, "row has", "rows have")} no date Athena could read, so ${plural(undated, "it's", "they're")} left out.`) : null,
        future ? h("p", { class: "ytimp-found__left" }, `${n(future)} ${plural(future, "is", "are")} dated after today, so ${plural(future, "it's", "they're")} left out.`) : null,
        ambiguous ? dateQuestion : null
      ),
      busiestMonths(parsed.views),
      most ? h("p", { class: "nfimp-most" }, most) : null,
      h(
        "div",
        { class: "card card--flush list ytimp-opts" },
        h(
          "div",
          { class: "row row--static" },
          h("span", { class: "tile tile--sm recipe-tile" }, icons.calendar()),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title" }, t.collection ? `Goes into ${t.collection.name}` : "Shows on your days"),
            h("span", { class: "row__meta" }, `Under Watched, on the day you watched each one${t.collection ? "" : ". A Life log you set up later keeps them"}`)
          )
        ),
        h(
          "div",
          { class: "row row--static" },
          h("span", { class: "tile tile--sm" }, icons.tv()),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title" }, "And into Watch & read"),
            h("span", { class: "row__meta" }, `${titlesText(shows, filmTitles)}${filmTitles && shows ? ": films as watched, shows as watching" : filmTitles ? ", as watched" : ", as watching"}. Ones you've changed stay as they are.`)
          )
        )
      ),
      h("div", { class: "ytimp__actions" }, add, h("p", { class: "form__hint ytimp__again" }, "Run it again any time with a newer file or another profile's. Nothing is added twice."))
    );
    add.focus({ preventScroll: true });
  }

  // ---------- 4. Adding it ----------

  async function importView(days: NetflixDay[], t: Target, total: number, from = 0, carried?: BatchResult) {
    sheet.setTitle(TITLE);
    sheet.setBack(null);
    const batches = batchNetflixDays(days);
    const totals: BatchResult = carried ?? { days_created: 0, days_updated: 0, days_unchanged: 0, days_skipped: 0, added: 0, added_films: 0, watch_read: { created: 0, updated: 0 } };
    const sizeOf = (b: NetflixDay[]) => b.reduce((k, d) => k + d.watched.reduce((m, w) => m + (w.episodes?.length ?? 1), 0), 0);
    const doneItems = (i: number) => batches.slice(0, i).reduce((k, b) => k + sizeOf(b), 0);

    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-label": "Added so far" }, fill);
    const now = h("p", { class: "ytimp-run__now" });
    const count = h("span", {});
    const stop = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Stop") as HTMLButtonElement;
    let stopped = false;
    stop.addEventListener("click", () => {
      stopped = true;
      stop.disabled = true;
      stop.textContent = "Stopping…";
      abort?.abort();
    });
    show(
      h("section", { class: "ytimp-run", "aria-live": "polite" }, now, meter, h("p", { class: "ytimp-run__meta" }, count)),
      h("p", { class: "steps__note ytimp__keep" }, icons.clock(), h("span", {}, "Keep this open until it's done. If you stop, what's added stays.")),
      h("div", { class: "ytimp__actions" }, stop)
    );

    const paint = (i: number) => {
      const d = doneItems(i);
      // A sliver from the start, so it reads as under way rather than stuck.
      fill.style.setProperty("--p", `${Math.max(2, Math.round((d / total) * 1000) / 10)}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(total)}`);
      const next = batches[i];
      now.textContent = next ? `Adding ${monthYear(next[0].day)}` : "Finishing…";
      count.textContent = `${n(d)} of ${n(total)} episodes and films`;
    };

    window.addEventListener("beforeunload", beforeUnload);
    let i = from;
    try {
      for (; i < batches.length; i++) {
        paint(i);
        if (stopped) break;
        abort = new AbortController();
        const r = await request<BatchResult>(path, { method: "POST", body: JSON.stringify({ days: batches[i], file }), signal: abort.signal });
        for (const k of ["days_created", "days_updated", "days_unchanged", "days_skipped", "added", "added_films"] as const) totals[k] += r[k];
        totals.watch_read.created += r.watch_read.created;
        totals.watch_read.updated += r.watch_read.updated;
      }
      paint(i);
    } catch (err) {
      window.removeEventListener("beforeunload", beforeUnload);
      const lost = !(stopped || (err instanceof DOMException && err.name === "AbortError"));
      if (!lost && !body.isConnected) return;
      stoppedView(days, t, total, i, totals, lost);
      return;
    }
    window.removeEventListener("beforeunload", beforeUnload);
    if (stopped && i < batches.length) stoppedView(days, t, total, i, totals, false);
    else doneView(total, totals, t);
  }

  // ---------- 5. Stopped, or the connection went ----------

  function stoppedView(days: NetflixDay[], t: Target, total: number, upTo: number, totals: BatchResult, lost: boolean) {
    const saved = batchNetflixDays(days)
      .slice(0, upTo)
      .reduce((k, b) => k + b.reduce((m, d) => m + d.watched.reduce((x, w) => x + (w.episodes?.length ?? 1), 0), 0), 0);
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(days, t, total, upTo, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${n(total)} added` : "Nothing added yet"),
        h("p", { class: "ytimp-end__sub" }, lost ? "Carry on when you're back online. Nothing is added twice." : "What's added stays. Carry on now, or import the same file later: nothing is added twice.")
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 6. Done ----------

  function doneView(total: number, r: BatchResult, t: Target) {
    sheet.setTitle(TITLE);
    const fresh = r.added > 0;
    if (fresh || r.watch_read.created) changed?.();
    // One main action: open what changed, or, with nothing new, just finish. Another profile is a quiet link.
    const open = fresh
      ? h("a", { class: "btn btn--primary btn--block", href: "#/days" }, "Open your days")
      : h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    open.addEventListener("click", () => sheet.close());
    const another = h("button", { class: "acct-link", type: "button" }, "Add another profile");
    another.addEventListener("click", () => stepsView(undefined, true));
    const close = h("button", { class: "acct-link", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    const days = r.days_created + r.days_updated;
    const already = total - r.added;
    const wr = r.watch_read.created;
    const extra = [
      fresh && already > 0 ? `${n(already)} ${plural(already, "was", "were")} already there.` : "",
      r.days_skipped ? `${n(r.days_skipped)} ${plural(r.days_skipped, "day", "days")} you'd archived or deleted ${plural(r.days_skipped, "was", "were")} left alone.` : "",
    ].filter(Boolean);
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, fresh ? `Added ${watchedText(r.added - r.added_films, r.added_films)}` : "Nothing new to add"),
        h(
          "p",
          { class: "ytimp-end__sub" },
          fresh
            ? `${days === 1 ? "On" : "Across"} ${n(days)} of your days.${wr ? ` ${n(wr)} new in Watch & read.` : ""}`
            : `Everything in this file is already on your days.`
        ),
        ...extra.map((e) => h("p", { class: "ytimp-end__extra" }, e))
      ),
      h("div", { class: "ytimp__actions" }, open, h("div", { class: "nfimp-links" }, another, close))
    );
    open.focus({ preventScroll: true });
  }

  stepsView();
}
