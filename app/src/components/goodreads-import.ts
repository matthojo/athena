/**
 * "Import your library": the books you finished, from Goodreads' Export
 * library file, into the Life log on the day you finished each one. Opened
 * from a Goodreads account's page in Sources.
 *
 * Same shape as the YouTube import (youtube-import.ts, whose styles it
 * shares): steps to get the file, a picker, what's in it, progress, done.
 * The file is read here, on the device (lib/goodreads-csv.ts), and only each
 * finished book's id, title, author, rating and day go to the server. Every
 * request is safe to repeat, so stopping, losing the connection or
 * importing the same file again never adds a book twice.
 */

import { FileTooBig, MAX_CSV_BYTES, readText, TOO_BIG } from "../lib/file-limits";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { request } from "../db/api";
import { rememberImport } from "../lib/youtube-import-memo";
import { batchBookDays, groupBooksByDay, LibraryError, parseLibrary, type LibraryBook, type LibraryDay, type LibraryParse } from "../../../lib/goodreads-csv";
import type { Connector } from "../types";
import "../styles/youtube-import.css";
import "../styles/goodreads-import.css";

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
  added_to_read: number;
}

const n = (x: number) => x.toLocaleString("en-GB");
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const monthYear = (day: string) => at(day).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => at(day).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const FILE_PROBLEM: Record<LibraryError["reason"] | "undated" | "offline", string> = {
  unreadable: "That isn't a Goodreads export. On Goodreads, press Export Library and choose the .csv file it gives you.",
  empty: "There are no books in that file. Check you exported from the account with your shelves.",
  undated: "None of these books has a date. Export again from Goodreads, then choose the new file.",
  offline: "Athena can't be reached right now. Check you're online, then choose the file again.",
};

/** Books finished per year, as a row of bars with the year under each. */
function yearStrip(books: LibraryBook[]): HTMLElement {
  const perYear = new Map<string, number>();
  for (const b of books) perYear.set(b.day.slice(0, 4), (perYear.get(b.day.slice(0, 4)) ?? 0) + 1);
  const first = Number(books[0].day.slice(0, 4));
  const last = Number(books[books.length - 1].day.slice(0, 4));
  const years = Array.from({ length: last - first + 1 }, (_, i) => String(first + i));
  const max = Math.max(1, ...years.map((y) => perYear.get(y) ?? 0));
  const every = years.length > 10 ? 2 : 1;
  return h(
    "figure",
    { class: "ytimp-years", role: "img", "aria-label": `Books finished per year: ${years.map((y) => `${y}, ${n(perYear.get(y) ?? 0)}`).join("; ")}` },
    h(
      "div",
      { class: "ytimp-years__bars", "aria-hidden": "true" },
      ...years.map((y) => {
        const v = perYear.get(y) ?? 0;
        return h("span", { class: "ytimp-years__bar", style: `--h:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%`, title: `${y}: ${n(v)} ${plural(v, "book", "books")}` });
      })
    ),
    h(
      "div",
      { class: "ytimp-years__labels", "aria-hidden": "true" },
      ...years.map((y, i) => h("span", {}, i % every === 0 || i === years.length - 1 ? `’${y.slice(2)}` : ""))
    )
  );
}

/** The last few books finished, newest first: proof it's the right file, with the dates they'll land on. */
function latest(books: LibraryBook[]): HTMLElement {
  const recent = books.slice(-3).reverse();
  return h(
    "div",
    { class: "grimp-latest" },
    h("p", { class: "group__label grimp-latest__label" }, `${recent.length === 1 ? "Last" : `Last ${recent.length === 2 ? "two" : "three"}`} ${recent[0].want ? "added" : "finished"}`),
    h(
      "ol",
      { class: "card card--flush list" },
      ...recent.map((b) =>
        h(
          "li",
          { class: "row row--static grimp-book" },
          h("span", { class: "grimp-book__day" }, h("span", { class: "grimp-book__d" }, String(at(b.day).getUTCDate())), h("span", { class: "grimp-book__m" }, at(b.day).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }))),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title" }, b.title),
            h("span", { class: "row__meta" }, [b.author, b.day.slice(0, 4) === String(new Date().getFullYear()) ? "" : b.day.slice(0, 4)].filter(Boolean).join(" · "))
          ),
          b.rating
            ? h("span", { class: "grimp-book__stars", role: "img", "aria-label": `You gave it ${b.rating} out of 5` }, "★".repeat(b.rating), h("span", { class: "grimp-book__empty", "aria-hidden": "true" }, "★".repeat(5 - b.rating)))
            : null
        )
      )
    )
  );
}

/** `changed`: books were added, so the account page can say when. */
export function openGoodreadsImport(account: Connector, changed?: () => void): void {
  const body = h("div", { class: "ytimp grimp" });
  const path = `/connectors/${encodeURIComponent(account.id)}/library`;
  let target: Target | null = null;
  let targetLoad: Promise<Target | null> | null = null;
  let abort: AbortController | null = null;
  let file: { items: number; days: number; to_read?: number } | null = null;

  const sheet: SheetHandle = openSheet({
    label: "Import your library",
    title: "Import your library",
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
    sheet.setTitle("Import your library");
    sheet.setBack(null);
    const input = h("input", { type: "file", accept: ".csv,text/csv", class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, "Choose the file") as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.[0] && void picked(input.files[0]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, matchMedia("(pointer: fine)").matches ? "Then drop the file here" : "Then choose the file here"),
      h("p", { class: "ytimp-drop__sub" }, h("span", { class: "ytimp-file" }, "goodreads_library_export.csv"), ", from your downloads."),
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
      const f = e.dataTransfer?.files?.[0];
      if (f) void picked(f);
    });

    show(
      h("p", { class: "ytimp__lede" }, "Goodreads only shares the dates you finished books in a file you download. Athena puts each book on that day."),
      setupBlock({
        steps: [
          { title: "Open Goodreads' export page", sub: "Sign in if asked. The Goodreads app can't export, so this opens the website.", open: "https://www.goodreads.com/review/import" },
          { title: "Press Export Library", sub: "It's at the top of the page. The file takes a minute or so." },
          { title: "Download the file", sub: "Tap the link that appears under the button." },
        ],
      }),
      drop,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, "Athena reads the file on this device and sends only each book's title, author, rating and date."))
    );
    if (problem) {
      drop.classList.add("has-problem");
      drop.scrollIntoView({ block: "center" });
      choose.focus({ preventScroll: true });
    }
  }

  // ---------- 2. Reading it ----------

  async function picked(f: File) {
    sheet.setTitle("Reading your library");
    show(
      h(
        "div",
        { class: "ytimp-busy", role: "status" },
        h("span", { class: "meter meter--busy", "aria-hidden": "true" }, h("span", { class: "meter__fill" })),
        h("p", { class: "ytimp-busy__line" }, `Reading ${f.name}…`)
      )
    );
    await new Promise((r) => setTimeout(r, 60));
    let parsed: LibraryParse;
    try {
      parsed = parseLibrary(await readText(f, MAX_CSV_BYTES));
    } catch (err) {
      stepsView(err instanceof FileTooBig ? TOO_BIG : FILE_PROBLEM[err instanceof LibraryError ? err.reason : "unreadable"]);
      return;
    }
    if (!parsed.books.length) {
      stepsView(FILE_PROBLEM.undated);
      return;
    }
    const t = target ?? (await loadTarget());
    if (!t) {
      stepsView(FILE_PROBLEM.offline);
      return;
    }
    reviewView(parsed, groupBooksByDay(parsed.books), t);
  }

  // ---------- 3. What's in it ----------

  function reviewView(parsed: LibraryParse, days: LibraryDay[], t: Target) {
    sheet.setTitle("Ready to add");
    sheet.setBack(() => stepsView());
    const books = parsed.books;
    const counts = h("input", { type: "checkbox", role: "switch", class: "switch", checked: true, "aria-labelledby": "grimp-count-title", "aria-describedby": "grimp-count-sub" }) as HTMLInputElement;
    const add = h("button", { class: "btn btn--primary btn--block", type: "button" }, t.collection ? `Add to ${t.collection.name}` : "Add to your days") as HTMLButtonElement;
    add.addEventListener("click", () => {
      file = { items: books.length, days: days.length, ...(wanted ? { to_read: wanted } : {}) };
      rememberImport(account.id, { at: new Date().toISOString(), ...file });
      void importView(days, t, counts.checked, books.length);
    });
    const done = books.filter((b) => !b.want);
    const wanted = books.length - done.length;
    const shelved = done.filter((b) => b.added).length;
    const shown = done.length ? done : books;
    const first = shown[0].day;
    const last = shown[shown.length - 1].day;
    const { reading, undated } = parsed.skipped;

    show(
      h(
        "section",
        { class: "ytimp-found" },
        h("p", { class: "ytimp-found__count" }, n(shown.length), h("span", { class: "ytimp-found__unit" }, ` ${plural(shown.length, "book", "books")} ${done.length ? "finished" : "to read"}`)),
        h(
          "p",
          { class: "ytimp-found__sub" },
          first === last ? `On ${longDay(first)}.` : `From ${monthYear(first)} to ${longDay(last)}.`,
          done.length && wanted ? ` Also ${n(wanted)} ${plural(wanted, "book", "books")} you want to read.` : ""
        ),
        last.slice(0, 4) !== first.slice(0, 4) ? yearStrip(shown) : null,
        shelved ? h("p", { class: "ytimp-found__left" }, `${n(shelved)} finished ${plural(shelved, "book has", "books have")} no finish date, so ${plural(shelved, "it goes", "they go")} on the day you shelved ${plural(shelved, "it", "them")}.`) : null,
        reading ? h("p", { class: "ytimp-found__left" }, `${n(reading)} ${plural(reading, "book", "books")} you're reading ${plural(reading, "isn't", "aren't")} added yet.`) : null,
        undated ? h("p", { class: "ytimp-found__left" }, `${n(undated)} ${plural(undated, "book has", "books have")} no dates at all, so ${plural(undated, "it's", "they're")} left out.`) : null
      ),
      latest(shown),
      h(
        "div",
        { class: "card card--flush list ytimp-opts" },
        h(
          "div",
          { class: "row row--static" },
          h("span", { class: "tile tile--sm recipe-tile" }, icons.book()),
          h(
            "span",
            { class: "row__body" },
            h("span", { class: "row__title" }, t.collection ? `Goes into ${t.collection.name}` : "Shows on your days"),
            h(
              "span",
              { class: "row__meta" },
              `${wanted ? "Finished books under Read, ones to read under Liked and saved" : "Under Read, on the day you finished each one"}${t.collection ? "" : ". A Life log you set up later keeps them."}`
            )
          )
        ),
        h(
          "label",
          { class: "row row--static ytimp-opts__count" },
          h("span", { class: "tile tile--sm" }, icons.hash()),
          h("span", { class: "row__body" }, h("span", { class: "row__title", id: "grimp-count-title" }, "Count books per day"), h("span", { class: "row__meta", id: "grimp-count-sub" }, "Fills Books finished for each day")),
          counts
        )
      ),
      h("div", { class: "ytimp__actions" }, add, h("p", { class: "form__hint ytimp__again" }, "Safe to run again with a newer export: no book is added twice."))
    );
    add.focus({ preventScroll: true });
  }

  // ---------- 4. Adding it ----------

  async function importView(days: LibraryDay[], t: Target, metrics: boolean, total: number, from = 0, carried?: BatchResult) {
    sheet.setTitle("Import your library");
    sheet.setBack(null);
    const batches = batchBookDays(days, 40);
    const totals: BatchResult = carried ?? { days_created: 0, days_updated: 0, days_unchanged: 0, days_skipped: 0, added: 0, added_to_read: 0 };
    const doneBooks = (i: number) => batches.slice(0, i).reduce((k, b) => k + b.reduce((m, d) => m + d.books.length, 0), 0);

    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-label": "Books added" }, fill);
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
      const d = doneBooks(i);
      // A sliver from the start, so it reads as under way rather than stuck.
      fill.style.setProperty("--p", `${Math.max(2, Math.round((d / total) * 1000) / 10)}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(total)} books`);
      const next = batches[i];
      const [y0, y1] = next ? [next[0].day.slice(0, 4), next[next.length - 1].day.slice(0, 4)] : ["", ""];
      now.textContent = !next ? "Finishing…" : y0 === y1 ? `Books from ${y0}` : `Books from ${y0} to ${y1}`;
      count.textContent = `${n(d)} of ${n(total)} ${plural(total, "book", "books")}`;
    };

    window.addEventListener("beforeunload", beforeUnload);
    let i = from;
    try {
      for (; i < batches.length; i++) {
        paint(i);
        if (stopped) break;
        abort = new AbortController();
        const r = await request<BatchResult>(path, { method: "POST", body: JSON.stringify({ days: batches[i], metrics, file }), signal: abort.signal });
        for (const k of Object.keys(totals) as Array<keyof BatchResult>) totals[k] += r[k];
      }
      paint(i);
    } catch (err) {
      window.removeEventListener("beforeunload", beforeUnload);
      const lost = !(stopped || (err instanceof DOMException && err.name === "AbortError"));
      if (!lost && !body.isConnected) return;
      stoppedView(days, t, metrics, total, i, totals, lost);
      return;
    }
    window.removeEventListener("beforeunload", beforeUnload);
    if (stopped && i < batches.length) stoppedView(days, t, metrics, total, i, totals, false);
    else doneView(total, totals, t);
  }

  // ---------- 5. Stopped, or the connection went ----------

  function stoppedView(days: LibraryDay[], t: Target, metrics: boolean, total: number, upTo: number, totals: BatchResult, lost: boolean) {
    const saved = batchBookDays(days, 40)
      .slice(0, upTo)
      .reduce((k, b) => k + b.reduce((m, d) => m + d.books.length, 0), 0);
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(days, t, metrics, total, upTo, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${n(total)} books added` : "Nothing added yet"),
        h("p", { class: "ytimp-end__sub" }, lost ? "Carry on when you're back online. No book is added twice." : "What's added stays. Carry on now, or import the same file later: no book is added twice.")
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 6. Done ----------

  function doneView(total: number, r: BatchResult, t: Target) {
    // The mark and "Added…" say it's done; the title says what this was.
    sheet.setTitle("Import your library");
    const fresh = r.added > 0;
    if (fresh) changed?.();
    const open = h("a", { class: "btn btn--primary btn--block", href: "#/days" }, "Open your days");
    open.addEventListener("click", () => sheet.close());
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    const days = r.days_created + r.days_updated;
    const finished = r.added - r.added_to_read;
    const already = total - r.added;
    const extra = [
      fresh && already > 0 && !r.days_skipped ? `${n(already)} ${plural(already, "was", "were")} already on your days.` : "",
      r.days_skipped ? `${n(r.days_skipped)} ${plural(r.days_skipped, "day", "days")} you'd archived or deleted ${plural(r.days_skipped, "was", "were")} left alone.` : "",
    ].filter(Boolean);
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, !fresh ? "Nothing new to add" : finished ? `Added ${n(finished)} ${plural(finished, "book", "books")} you've read` : `Added ${n(r.added_to_read)} ${plural(r.added_to_read, "book", "books")} to read`),
        h(
          "p",
          { class: "ytimp-end__sub" },
          fresh
            ? `${finished && r.added_to_read ? `And ${n(r.added_to_read)} to read. ` : ""}${days === 1 ? "On" : "Across"} ${n(days)} of your days.`
            : `All ${n(total)} ${plural(total, "book", "books")} in this file ${plural(total, "is", "are")} already on your days.`
        ),
        ...extra.map((e) => h("p", { class: "ytimp-end__extra" }, e))
      ),
      h("div", { class: "ytimp__actions" }, open, close)
    );
    open.focus({ preventScroll: true });
  }

  stepsView();
}
