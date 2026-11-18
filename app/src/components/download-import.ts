/**
 * The flow the Apple Music and BBC iPlayer imports share
 * (apple-music-import.ts, iplayer-import.ts): how to get the file, a
 * picker, reading it in steps, a preview, the import, a summary with Undo.
 * Each import brings its own words, parser and preview; this holds the
 * steps between, in the look of the Amazon import (amazon-import.ts), whose
 * styles it reuses.
 *
 * Everything is read on the device. Days go to /api/days/import/<format> in
 * whole-day batches, each safe to repeat; the summary's Undo archives what
 * this import added. In sample mode there's no server: the made-up export
 * is read here and the server's answers are worked out here too.
 */
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { isSampleMode, request } from "../db/api";
import { rememberImport } from "../lib/youtube-import-memo";
import { blobSource, findExportFiles, isZipSource, ZipError } from "../../../lib/apple-music-export";
import type { SetupStep } from "./setup-steps";
import "../styles/youtube-import.css";
import "../styles/goodreads-import.css";
import "../styles/netflix-import.css";
import "../styles/amazon-import.css";
import "../styles/download-import.css";

export const n = (x: number) => x.toLocaleString("en-GB");
export const count = (x: number, one: string, many: string) => `${n(x)} ${plural(x, one, many)}`;
const at = (day: string) => new Date(`${day}T12:00:00Z`);
export const monthYear = (day: string) => at(day).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
export const shortMonth = (day: string) => at(day).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
export const longDay = (day: string) => at(day).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** "45 minutes", "3 hours", "120 hours". */
export const duration = (minutes: number) => (minutes < 90 ? count(minutes, "minute", "minutes") : count(Math.round(minutes / 60), "hour", "hours"));
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const MAX_LOOSE_CSV = 200 * 2 ** 20;

export interface Target {
  collection: { id: string; name: string } | null;
  source: string;
}

/** What the server answers for a batch of days (netlify/lib/days/import-routes.ts DownloadResult). */
export interface DaysResult {
  days_created: number;
  days_updated: number;
  days_unchanged: number;
  days_skipped: number;
  added: number;
  days_added: number;
  minutes_added: number;
  skipped_lastfm: number;
  watch_read: { created: number; updated: number };
  ids: { entries: string[]; watch_read: string[] };
}

export interface Totals {
  added: number;
  days: number;
  minutes: number;
  skippedLastfm: number;
  watchRead: { created: number; updated: number };
  undo: { entries: string[]; watch_read: string[] };
}

export interface Batch {
  days: Array<{ day: string }>;
  /** Songs or programmes in it, for the meter. */
  size: number;
}

export interface DownloadImport<X> {
  format: "apple_music" | "iplayer" | "spotify_history";
  title: string;
  /** The service's mark, large, for the preview. */
  mark: () => HTMLElement;
  lede: string;
  steps: SetupStep[];
  choose: string;
  dropSub: string;
  privacy: string;
  problems: { notFile: string; nothing: string };
  sample: () => Array<{ name: string; text: string }>;
  sniff: (header: string[]) => string | null;
  /** Files known by name instead of a CSV header (Spotify's JSON): inside the zip, or chosen on their own. */
  byName?: (name: string) => string | null;
  parse: (files: Array<{ name: string; text: string }>, o: { tz: string; today: string; pause: () => Promise<void>; progress: (f: number) => void }) => Promise<X>;
  readingLine: string;
  isEmpty: (x: X) => boolean;
  /** The preview's middle: headline, tiles, lists. */
  preview: (x: X, t: Target) => { headline: HTMLElement; blocks: Array<HTMLElement | null>; where: Array<HTMLElement | null>; items: number; days: number };
  batches: (x: X) => Batch[];
  batchLabel: (b: Batch) => string;
  /** Sample mode: what the server would say for a batch. */
  pretend: (b: Batch) => DaysResult;
  summary: (r: Totals, t: Target) => { title: string; sub: string; rows: HTMLElement[]; open: { href: string; label: string } };
  undoLine: (put: { entries: number; watch_read: number }) => string;
}

export const zero = (): Totals => ({ added: 0, days: 0, minutes: 0, skippedLastfm: 0, watchRead: { created: 0, updated: 0 }, undo: { entries: [], watch_read: [] } });

/** One row in a card list: a tile, a title, a line under it. */
export const where = (icon: IconName, title: string, meta: string) =>
  h("div", { class: "row row--static" }, h("span", { class: "tile tile--sm" }, icons[icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), meta ? h("span", { class: "row__meta" }, meta) : null));

/** A preview tile: icon, a big number, what it counts and a line of detail. */
export function tile(kind: string, icon: IconName, big: string, what: string, more: string, i: number): HTMLElement {
  return h(
    "li",
    { class: `amzimp-kind dlimp-kind dlimp-kind--${kind}`, style: `--i:${i}` },
    h("span", { class: "amzimp-kind__icon", "aria-hidden": "true" }, icons[icon]()),
    h("span", { class: "amzimp-kind__n" }, big),
    h("span", { class: "amzimp-kind__what" }, what, more ? h("small", {}, more) : null)
  );
}

/** A ranked list with bars: top artists, top programmes. */
export function ranked(label: string, rows: Array<{ name: string; value: number; meta: string; sub?: string }>, tint: string): HTMLElement | null {
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h(
    "figure",
    { class: `dlimp-rank dlimp-rank--${tint}` },
    h("figcaption", { class: "group__label" }, label),
    h(
      "ol",
      { class: "dlimp-rank__list", role: "list" },
      ...rows.map((r, i) =>
        h(
          "li",
          { class: "dlimp-rank__item", style: `--w:${Math.max(4, Math.round((r.value / max) * 100))}%; --i:${i}` },
          h("span", { class: "dlimp-rank__pos", "aria-hidden": "true" }, String(i + 1)),
          h("span", { class: "dlimp-rank__body" }, h("span", { class: "dlimp-rank__name" }, r.name, r.sub ? h("small", {}, r.sub) : null), h("span", { class: "dlimp-rank__track", "aria-hidden": "true" }, h("span", { class: "dlimp-rank__bar" }))),
          h("span", { class: "dlimp-rank__n" }, r.meta)
        )
      )
    )
  );
}

/** A row of small chips: songs on repeat, programmes lately. */
export function chips(label: string, names: Array<{ text: string; title?: string }>): HTMLElement | null {
  if (!names.length) return null;
  return h(
    "section",
    { class: "amzimp-recent" },
    h("h3", { class: "group__label" }, label),
    h("ul", { class: "amzimp-recent__list", role: "list" }, ...names.map((x, i) => h("li", { class: "amzimp-recent__item", style: `--i:${i}`, title: x.title ?? x.text }, x.text)))
  );
}

export function openDownloadImport<X>(cfg: DownloadImport<X>, changed?: () => void): void {
  const sample = isSampleMode();
  const PATH = `/days/import/${cfg.format}`;
  const MEMO = `file-${cfg.format}`;
  const body = h("div", { class: `ytimp grimp nfimp amzimp dlimp dlimp--${cfg.format}` });
  let target: Target | null = null;
  let targetLoad: Promise<Target | null> | null = null;
  let abort: AbortController | null = null;
  let cancelled = false;

  const sheet: SheetHandle = openSheet({
    label: cfg.title,
    title: cfg.title,
    body,
    onClose: () => {
      cancelled = true;
      abort?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
    },
  });

  const loadTarget = () =>
    sample
      ? Promise.resolve<Target>({ collection: null, source: "sample" })
      : (targetLoad ??= request<Target>(PATH)
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

  const show = (...children: Array<HTMLElement | null | false>) => {
    body.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
    body.scrollIntoView({ block: "start" });
  };

  const PROBLEM = {
    "not-zip": cfg.problems.notFile,
    nothing: cfg.problems.nothing,
    "too-big": "That file is too big to read here. Try the CSV on its own.",
    unreadable: "Athena couldn't open that file. Download it again, then choose the new one.",
    offline: "Athena can't be reached right now. Check you're online, then choose the file again.",
  } as const;

  // ---------- 1. How to get the file, and the picker ----------

  function stepsView(problem?: string) {
    sheet.setTitle(cfg.title);
    sheet.setBack(null);
    const fine = matchMedia("(pointer: fine)").matches;
    const input = h("input", { type: "file", accept: cfg.byName ? ".zip,.json,application/zip,application/json" : ".zip,.csv,application/zip,text/csv", multiple: true, class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, cfg.choose) as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.length && void picked([...input.files]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, fine ? "Then drop the file here" : "Then choose the file here"),
      h("p", { class: "ytimp-drop__sub" }, cfg.dropSub),
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

    let trySample: HTMLElement | null = null;
    if (sample) {
      trySample = h("button", { class: "btn btn--soft amzimp-sample", type: "button" }, icons.sparkle(), "Try a sample file");
      trySample.addEventListener("click", () => void readSample());
    }

    show(
      h("p", { class: "ytimp__lede" }, cfg.lede),
      setupBlock({ steps: cfg.steps }),
      drop,
      trySample,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, cfg.privacy))
    );
    if (problem) {
      drop.classList.add("has-problem");
      drop.scrollIntoView({ block: "center" });
      choose.focus({ preventScroll: true });
    }
  }

  // ---------- 2. Reading it, in steps ----------

  function busyView(line: string) {
    sheet.setTitle("Reading your file");
    sheet.setBack(null);
    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter meter--busy", "aria-hidden": "true" }, fill);
    const text = h("p", { class: "ytimp-busy__line" }, line);
    show(h("div", { class: "ytimp-busy", role: "status" }, meter, text));
    return {
      say: (s: string, fraction?: number) => {
        text.textContent = s;
        if (fraction !== undefined) {
          meter.classList.remove("meter--busy");
          fill.style.setProperty("--p", `${Math.max(3, Math.round(fraction * 100))}%`);
        }
      },
    };
  }

  async function picked(files: File[]) {
    const busy = busyView(files.length === 1 ? `Opening ${files[0].name}…` : `Opening ${files.length} files…`);
    await breathe();
    const texts: Array<{ name: string; text: string }> = [];
    try {
      for (const f of files) {
        const src = blobSource(f);
        if (await isZipSource(src)) {
          const found = await findExportFiles(src, cfg.sniff, { byName: cfg.byName, progress: (k, total) => k % 25 === 0 && busy.say(`Looking through ${n(total)} files…`, (k / total) * 0.3) });
          for (const [i, x] of found.entries()) {
            if (cancelled) return;
            busy.say(`Reading ${x.name.split("/").pop()}…`, 0.3 + (i / Math.max(1, found.length)) * 0.2);
            texts.push({ name: x.name, text: await x.text() });
            await breathe();
          }
        } else if (cfg.byName?.(f.name) && f.size <= MAX_LOOSE_CSV) {
          texts.push({ name: f.name, text: await f.text() });
        } else if (/\.csv$/i.test(f.name) && f.size <= MAX_LOOSE_CSV) {
          texts.push({ name: f.name, text: await f.text() });
        } else if (/\.csv$/i.test(f.name)) throw new ZipError("too-big");
        else throw new ZipError("not-zip");
      }
    } catch (err) {
      stepsView(PROBLEM[err instanceof ZipError ? err.reason : "unreadable"]);
      return;
    }
    await read(texts, busy);
  }

  async function readSample() {
    const busy = busyView("Opening the sample file…");
    await breathe();
    await read(cfg.sample(), busy);
  }

  async function read(texts: Array<{ name: string; text: string }>, busy: ReturnType<typeof busyView>) {
    let parsed: X;
    try {
      parsed = await cfg.parse(texts, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, today: todayIso(), pause: breathe, progress: (f) => busy.say(cfg.readingLine, 0.5 + f * 0.5) });
    } catch {
      stepsView(PROBLEM.unreadable);
      return;
    }
    if (cancelled) return;
    if (cfg.isEmpty(parsed)) {
      stepsView(PROBLEM.nothing);
      return;
    }
    const t = target ?? (await loadTarget());
    if (!t) {
      stepsView(PROBLEM.offline);
      return;
    }
    reviewView(parsed, t);
  }

  // ---------- 3. What's in it ----------

  function reviewView(x: X, t: Target) {
    sheet.setTitle("Ready to import");
    sheet.setBack(() => stepsView());
    const p = cfg.preview(x, t);
    const go = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Import") as HTMLButtonElement;
    go.addEventListener("click", () => {
      rememberImport(MEMO, { at: new Date().toISOString(), items: p.items, days: p.days });
      void importView(x, t, cfg.batches(x), p.items, p.days);
    });
    show(
      h("div", { class: "amzimp-hero dlimp-hero" }, h("span", { class: "amzimp-hero__mark" }, cfg.mark()), p.headline),
      ...p.blocks,
      h("div", { class: "card card--flush list ytimp-opts" }, ...p.where.filter((e): e is HTMLElement => !!e)),
      h("div", { class: "ytimp__actions" }, go, h("p", { class: "form__hint ytimp__again" }, "Run it again with a newer file any time. Nothing is added twice.")),
      sample ? h("p", { class: "amzimp-small" }, "This is a made-up file. In sample mode nothing is saved.") : null
    );
    go.focus({ preventScroll: true });
  }

  // ---------- 4. Importing ----------

  async function importView(x: X, t: Target, batches: Batch[], total: number, days: number, from = 0, carried?: Totals) {
    sheet.setTitle(cfg.title);
    sheet.setBack(null);
    const totals = carried ?? zero();
    const size = batches.reduce((k, b) => k + b.size, 0) || 1;
    const doneBy = (i: number) => batches.slice(0, i).reduce((k, b) => k + b.size, 0);

    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(size), "aria-label": "Imported so far" }, fill);
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
      const d = doneBy(i);
      fill.style.setProperty("--p", `${Math.max(2, Math.round((d / size) * 1000) / 10)}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(size)}`);
      now.textContent = batches[i] ? cfg.batchLabel(batches[i]) : "Finishing…";
      counter.textContent = `${n(d)} of ${n(size)}`;
    };

    window.addEventListener("beforeunload", beforeUnload);
    let i = from;
    try {
      for (; i < batches.length; i++) {
        paint(i);
        if (stopped || cancelled) break;
        const b = batches[i];
        abort = new AbortController();
        const file = { items: total, days };
        const r = sample
          ? await new Promise<DaysResult>((res) => setTimeout(() => res(cfg.pretend(b)), 160))
          : await request<DaysResult>(PATH, { method: "POST", body: JSON.stringify({ part: "days", days: b.days, file }), signal: abort.signal });
        totals.added += r.added;
        totals.days += r.days_added;
        totals.minutes += r.minutes_added;
        totals.skippedLastfm += r.skipped_lastfm;
        totals.watchRead.created += r.watch_read.created;
        totals.watchRead.updated += r.watch_read.updated;
        totals.undo.entries.push(...r.ids.entries);
        totals.undo.watch_read.push(...r.ids.watch_read);
      }
      paint(i);
    } catch (err) {
      window.removeEventListener("beforeunload", beforeUnload);
      const lost = !(stopped || (err instanceof DOMException && err.name === "AbortError"));
      if (!lost && !body.isConnected) return;
      stoppedView(x, t, batches, total, days, i, totals, lost);
      return;
    }
    window.removeEventListener("beforeunload", beforeUnload);
    if (!body.isConnected) return;
    if (stopped && i < batches.length) stoppedView(x, t, batches, total, days, i, totals, false);
    else doneView(totals, t);
  }

  // ---------- 5. Stopped, or the connection went ----------

  function stoppedView(x: X, t: Target, batches: Batch[], total: number, days: number, upTo: number, totals: Totals, lost: boolean) {
    const saved = batches.slice(0, upTo).reduce((k, b) => k + b.size, 0);
    const size = batches.reduce((k, b) => k + b.size, 0);
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(x, t, batches, total, days, upTo, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${n(size)} imported` : "Nothing imported yet"),
        h("p", { class: "ytimp-end__sub" }, lost ? "Carry on when you're back online. Nothing is added twice." : "What's imported stays. Carry on now, or import the same file later: nothing is added twice.")
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 6. The summary, with Undo ----------

  function doneView(r: Totals, t: Target) {
    sheet.setTitle(cfg.title);
    const fresh = r.added + r.watchRead.created;
    if (fresh) changed?.();
    const s = cfg.summary(r, t);
    const open = fresh ? h("a", { class: "btn btn--primary btn--block", href: s.open.href }, s.open.label) : h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    open.addEventListener("click", () => sheet.close());
    const undoable = r.undo.entries.length + r.undo.watch_read.length;
    const undo = h("button", { class: "btn btn--soft btn--block amzimp-undo", type: "button" }, icons.restore(), "Undo this import") as HTMLButtonElement;
    undo.addEventListener("click", () => void undoView(r));
    show(
      h(
        "section",
        { class: "ytimp-end dlimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, s.title),
        h("p", { class: "ytimp-end__sub" }, s.sub)
      ),
      s.rows.length ? h("div", { class: "card card--flush list amzimp-summary" }, ...s.rows) : null,
      h("div", { class: "ytimp__actions" }, open, undoable ? undo : null, undoable ? h("p", { class: "form__hint ytimp__again" }, "Undo puts away what this import added. Anything that was there before stays.") : null),
      sample ? h("p", { class: "amzimp-small" }, "Sample mode: nothing was saved.") : null
    );
    open.focus({ preventScroll: true });
  }

  async function undoView(r: Totals) {
    sheet.setTitle("Undoing");
    sheet.setBack(null);
    show(h("div", { class: "ytimp-busy", role: "status" }, h("span", { class: "meter meter--busy", "aria-hidden": "true" }, h("span", { class: "meter__fill" })), h("p", { class: "ytimp-busy__line" }, "Putting away what this import added…")));
    const u = r.undo;
    const put = { entries: 0, watch_read: 0 };
    try {
      if (sample) {
        await new Promise((res) => setTimeout(res, 400));
        put.entries = u.entries.length;
        put.watch_read = u.watch_read.length;
      } else {
        for (let i = 0; i < Math.max(u.entries.length, 1); i += 4000) {
          const res = await request<{ entries: number; watch_read: number }>(PATH, { method: "POST", body: JSON.stringify({ part: "undo", entries: u.entries.slice(i, i + 4000), watch_read: i === 0 ? u.watch_read : [] }) });
          put.entries += res.entries;
          put.watch_read += res.watch_read;
        }
      }
    } catch {
      sheet.setTitle("Couldn't undo");
      const again = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Try again") as HTMLButtonElement;
      again.addEventListener("click", () => void undoView(r));
      show(
        h("section", { class: "ytimp-end" }, h("span", { class: "ytimp-end__mark ytimp-end__mark--warn", "aria-hidden": "true" }, icons.wifiOff()), h("p", { class: "ytimp-end__title" }, "Couldn't reach Athena"), h("p", { class: "ytimp-end__sub" }, "Nothing was put away yet. Try again when you're online.")),
        h("div", { class: "ytimp__actions" }, again)
      );
      return;
    }
    changed?.();
    sheet.setTitle(cfg.title);
    const close = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: "ytimp-end__mark ytimp-end__mark--quiet", "aria-hidden": "true" }, icons.archive()),
        h("p", { class: "ytimp-end__title" }, "Import undone"),
        h("p", { class: "ytimp-end__sub" }, cfg.undoLine(put))
      ),
      h("div", { class: "ytimp__actions" }, close)
    );
    close.focus({ preventScroll: true });
  }

  stepsView();
}
