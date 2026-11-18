/**
 * "Import your Amazon data": orders, returns, digital orders, Kindle
 * reading, Audible listening and Prime Video viewing, from the zip Amazon
 * sends after Account → Data and privacy → Request your data. Opened from
 * Amazon's card in Sources (views/connect.ts FILE_IMPORTS).
 *
 * Same shape as the Netflix and YouTube imports (whose styles it shares):
 * steps to get the file, a picker, what's in it, progress, a summary. The
 * zip is read here, on the device (lib/amazon-export.ts), entry by entry and
 * in steps, so a big export doesn't freeze the page. Orders go to Purchases
 * (prices sealed with finance), the rest to Days and Watch & read, through
 * /api/days/import/amazon. Every request is safe to repeat. The summary's
 * Undo archives what this import added.
 *
 * In sample mode there's no server: "Try a sample export" reads a made-up
 * export (lib/amazon-sample.ts) and the import runs here.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { setupBlock } from "./setup-steps";
import { plural } from "../lib/format";
import { isSampleMode, request } from "../db/api";
import { rememberImport } from "../lib/youtube-import-memo";
import { sampleAmazonExport } from "../lib/amazon-sample";
import { backfillMark } from "./backfill-marks";
import {
  AmazonExportError,
  batchMediaDays,
  batchOrders,
  blobSource,
  busiestMonths,
  findAmazonFiles,
  isZipSource,
  parseAmazonExport,
  type AmazonExport,
  type MediaSource,
} from "../../../lib/amazon-export";
import "../styles/youtube-import.css";
import "../styles/goodreads-import.css";
import "../styles/netflix-import.css";
import "../styles/amazon-import.css";

const TITLE = "Import your Amazon data";
const PATH = "/days/import/amazon";
const MEMO = "file-amazon";
const MAX_LOOSE_CSV = 50 * 2 ** 20;

const n = (x: number) => x.toLocaleString("en-GB");
const count = (x: number, one: string, many: string) => `${n(x)} ${plural(x, one, many)}`;
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const monthYear = (day: string) => at(day).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDay = (day: string) => at(day).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hours = (minutes: number) => (minutes < 90 ? count(minutes, "minute", "minutes") : count(Math.round(minutes / 60), "hour", "hours"));
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const PROBLEM = {
  "not-zip": "That isn't an Amazon export. Choose the zip Amazon emailed you a link to, or the CSV files inside it.",
  nothing: "There's nothing Athena can read in that file: no orders, reading or viewing. Check it's the export from Amazon's Request your data page.",
  "too-big": "That export is too big to read here. Try one part of it at a time.",
  unreadable: "Athena couldn't open that zip. Download it again from Amazon, then choose the new file.",
  offline: "Athena can't be reached right now. Check you're online, then choose the file again.",
} as const;

interface Target {
  collection: { id: string; name: string } | null;
  source: string;
}

interface OrdersResult {
  created: number;
  existing: number;
  skipped: number;
  prices_sealed: number;
  ids: { purchases: string[]; finance: string[] };
}

interface MediaResult {
  days_created: number;
  days_updated: number;
  days_unchanged: number;
  days_skipped: number;
  added: number;
  by_source: Record<MediaSource, number>;
  days_by_source: Record<MediaSource, number>;
  ids: { entries: Array<{ source: MediaSource; external_id: string }> };
}

interface FinishedResult {
  created: number;
  updated: number;
  ids: { watch_read: string[] };
}

/** What this import changed, added up across batches, and what Undo puts away. */
interface Totals {
  orders: { created: number; existing: number; skipped: number };
  media: { added: number; days: number; by_source: Record<MediaSource, number>; days_by_source: Record<MediaSource, number> };
  finished: { created: number; updated: number };
  undo: { entries: Array<{ source: MediaSource; external_id: string }>; purchases: string[]; watch_read: string[]; finance: string[] };
}

const zero = (): Totals => ({
  orders: { created: 0, existing: 0, skipped: 0 },
  media: { added: 0, days: 0, by_source: { kindle: 0, audible: 0, prime_video: 0 }, days_by_source: { kindle: 0, audible: 0, prime_video: 0 } },
  finished: { created: 0, updated: 0 },
  undo: { entries: [], purchases: [], watch_read: [], finance: [] },
});

/** One request's worth of work, in the order it runs. */
type Step = { kind: "orders"; body: unknown; size: number; label: string } | { kind: "media"; body: unknown; size: number; label: string } | { kind: "finished"; body: unknown; size: number; label: string };

function plan(x: AmazonExport): Step[] {
  const steps: Step[] = [];
  for (const b of batchOrders(x.orders)) steps.push({ kind: "orders", body: { part: "orders", orders: b }, size: b.length, label: `Adding orders from ${monthYear(b[0].day)}` });
  for (const b of batchMediaDays(x.days)) steps.push({ kind: "media", body: { part: "media", days: b }, size: b.reduce((k, d) => k + d.items.length, 0), label: `Adding ${monthYear(b[0].day)} to your days` });
  for (let i = 0; i < x.finished.length; i += 2000) {
    const b = x.finished.slice(i, i + 2000);
    steps.push({ kind: "finished", body: { part: "finished", finished: b }, size: b.length, label: "Adding finished books to Watch & read" });
  }
  return steps;
}

/** In sample mode: what the server would say, as if everything were new. */
function pretend(step: Step): OrdersResult | MediaResult | FinishedResult {
  const b = step.body as { orders?: Array<{ id: string; day: string }>; days?: Array<{ day: string; items: Array<{ source: MediaSource; key: string }> }>; finished?: unknown[] };
  if (step.kind === "orders") return { created: b.orders!.length, existing: 0, skipped: 0, prices_sealed: new Set(b.orders!.map((o) => o.day)).size, ids: { purchases: b.orders!.map((o) => `sample-${o.id}`), finance: [] } };
  if (step.kind === "media") {
    const items = b.days!.flatMap((d) => d.items.map((x) => ({ ...x, day: d.day })));
    const by_source: Record<MediaSource, number> = { kindle: 0, audible: 0, prime_video: 0 };
    for (const x of items) by_source[x.source]++;
    const days_by_source: Record<MediaSource, number> = { kindle: 0, audible: 0, prime_video: 0 };
    for (const s of ["kindle", "audible", "prime_video"] as const) days_by_source[s] = new Set(items.filter((x) => x.source === s).map((x) => x.day)).size;
    return { days_created: b.days!.length, days_updated: 0, days_unchanged: 0, days_skipped: 0, added: items.length, by_source, days_by_source, ids: { entries: items.map((x) => ({ source: x.source, external_id: `${x.day}:${x.key}` })) } };
  }
  return { created: b.finished!.length, updated: 0, ids: { watch_read: [] } };
}

/** `changed`: something was added or undone, so Sources can say when. */
export function openAmazonImport(changed?: () => void): void {
  const sample = isSampleMode();
  const body = h("div", { class: "ytimp grimp nfimp amzimp" });
  let target: Target | null = null;
  let targetLoad: Promise<Target | null> | null = null;
  let abort: AbortController | null = null;
  let cancelled = false;

  const sheet: SheetHandle = openSheet({
    label: TITLE,
    title: TITLE,
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

  // ---------- 1. How to get the file, and the picker ----------

  function stepsView(problem?: string) {
    sheet.setTitle(TITLE);
    sheet.setBack(null);
    const fine = matchMedia("(pointer: fine)").matches;
    const input = h("input", { type: "file", accept: ".zip,.csv,application/zip,text/csv", multiple: true, class: "ytimp-drop__input", tabindex: -1, "aria-hidden": "true" }) as HTMLInputElement;
    const choose = h("button", { class: "btn btn--primary", type: "button" }, "Choose the zip") as HTMLButtonElement;
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files?.length && void picked([...input.files]));
    const drop = h(
      "div",
      { class: "ytimp-drop" },
      h("span", { class: "ytimp-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "ytimp-drop__title" }, fine ? "Then drop the zip here" : "Then choose the zip here"),
      h("p", { class: "ytimp-drop__sub" }, "If Amazon sent it in parts, add them all at once."),
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
      trySample = h("button", { class: "btn btn--soft amzimp-sample", type: "button" }, icons.sparkle(), "Try a sample export");
      trySample.addEventListener("click", () => void readSample());
    }

    show(
      h("p", { class: "ytimp__lede" }, "Amazon doesn't share your orders or your reading with other apps, but it will send you a copy. Athena puts what you bought in Purchases, and what you read, listened to and watched on your days."),
      setupBlock({
        steps: [
          { title: "Ask Amazon for your data", sub: "Go to Request your data and choose Your Orders, Kindle, Audible and Prime Video, or everything.", open: "https://www.amazon.co.uk/hz/privacy-central/data-requests/preview.html" },
          { title: "Confirm the email", sub: "Amazon sends a link to check it's you. The files usually come within a few days, sometimes longer." },
          { title: "Download the zip", sub: "When the second email comes, download every part it links to." },
        ],
      }),
      drop,
      trySample,
      h("p", { class: "steps__note ytimp__privacy" }, icons.shield(), h("span", {}, "Athena reads the zip on this device. It sends item names, order numbers, dates and what you read and watched. Prices are kept encrypted and never shown on a purchase. Addresses and cards stay here."))
    );
    if (problem) {
      drop.classList.add("has-problem");
      drop.scrollIntoView({ block: "center" });
      choose.focus({ preventScroll: true });
    }
  }

  // ---------- 2. Reading it, in steps ----------

  function busyView(line: string) {
    sheet.setTitle("Reading your export");
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
          const found = await findAmazonFiles(src, { progress: (k, total) => k % 25 === 0 && busy.say(`Looking through ${n(total)} files…`, (k / total) * 0.3) });
          for (const [i, x] of found.entries()) {
            if (cancelled) return;
            busy.say(`Reading ${x.name.split("/").pop()}…`, 0.3 + (i / Math.max(1, found.length)) * 0.2);
            texts.push({ name: x.name, text: await x.text() });
            await breathe();
          }
        } else if (/\.csv$/i.test(f.name) && f.size <= MAX_LOOSE_CSV) {
          texts.push({ name: f.name, text: await f.text() });
        } else if (/\.csv$/i.test(f.name)) throw new AmazonExportError("too-big");
        else throw new AmazonExportError("not-zip");
      }
    } catch (err) {
      stepsView(PROBLEM[err instanceof AmazonExportError ? err.reason : "unreadable"]);
      return;
    }
    await read(texts, busy);
  }

  async function readSample() {
    const busy = busyView("Opening the sample export…");
    await breathe();
    await read(sampleAmazonExport(), busy);
  }

  async function read(texts: Array<{ name: string; text: string }>, busy: ReturnType<typeof busyView>) {
    let parsed: AmazonExport;
    try {
      parsed = await parseAmazonExport(texts, {
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: navigator.language,
        today: todayIso(),
        pause: breathe,
        progress: (f) => busy.say("Reading your orders, books and shows…", 0.5 + f * 0.5),
      });
    } catch {
      stepsView(PROBLEM.unreadable);
      return;
    }
    if (cancelled) return;
    if (!parsed.range) {
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

  function reviewView(x: AmazonExport, t: Target) {
    sheet.setTitle("Ready to import");
    sheet.setBack(() => stepsView());
    const c = x.counts;
    const { first, last } = x.range!;
    const total = x.orders.length + x.days.reduce((k, d) => k + d.items.length, 0) + x.finished.length;

    const tile = (kind: string, icon: IconName, big: number, what: string, more: string, i: number) =>
      h(
        "li",
        { class: `amzimp-kind amzimp-kind--${kind}`, style: `--i:${i}` },
        h("span", { class: "amzimp-kind__icon", "aria-hidden": "true" }, icons[icon]()),
        h("span", { class: "amzimp-kind__n" }, n(big)),
        h("span", { class: "amzimp-kind__what" }, what, more ? h("small", {}, more) : null)
      );
    const tiles: HTMLElement[] = [];
    const add = (cond: unknown, kind: string, icon: IconName, big: number, what: string, more = "") => cond && tiles.push(tile(kind, icon, big, what, more, tiles.length));
    add(c.orders, "orders", "parcel", c.orders, plural(c.orders, "order", "orders"), count(c.items, "item", "items"));
    add(c.returned, "returned", "restore", c.returned, `${plural(c.returned, "item", "items")} sent back`);
    add(c.digital, "digital", "laptop", c.digital, `digital ${plural(c.digital, "order", "orders")}`, "Kindle books, apps, films");
    add(c.kindleDays, "kindle", "book", c.kindleDays, `${plural(c.kindleDays, "day", "days")} reading`, `${hours(c.kindleMinutes)} on Kindle`);
    add(c.audibleDays, "audible", "mic", c.audibleDays, `${plural(c.audibleDays, "day", "days")} listening`, `${hours(c.audibleMinutes)} on Audible`);
    add(c.primeDays, "prime", "tv", c.primeDays, `${plural(c.primeDays, "day", "days")} watching`, `${count(c.primeTitles, "title", "titles")} on Prime Video`);

    // A few of the latest things bought: proof it's your account.
    const recent = x.orders
      .filter((o) => !o.digital && o.status !== "cancelled")
      .slice(-12)
      .reverse()
      .flatMap((o) => o.items)
      .filter((it, i, all) => all.findIndex((y) => y.name === it.name) === i)
      .slice(0, 6);
    const recentBlock = recent.length
      ? h(
          "section",
          { class: "amzimp-recent" },
          h("h3", { class: "group__label" }, "Most recent"),
          h("ul", { class: "amzimp-recent__list", role: "list" }, ...recent.map((it, i) => h("li", { class: `amzimp-recent__item${it.returned ? " amzimp-recent__item--back" : ""}`, style: `--i:${i}`, title: it.returned ? `${it.name} (returned)` : it.name }, it.name)))
        )
      : null;

    const months = busiestMonths(x);
    const max = months[0] ? months[0].orders + months[0].media : 0;
    const monthsBlock =
      months.length >= 3 && total >= 20
        ? h(
            "figure",
            { class: "nfimp-months" },
            h("figcaption", { class: "group__label nfimp-months__label" }, "Busiest months"),
            h(
              "ol",
              { class: "nfimp-months__list", role: "list" },
              ...months.map((m, i) =>
                h(
                  "li",
                  { class: "nfimp-month", style: `--w:${Math.max(3, Math.round(((m.orders + m.media) / max) * 100))}%; --i:${i}` },
                  h("span", { class: "nfimp-month__name" }, monthYear(`${m.month}-15`)),
                  h("span", { class: "nfimp-month__track", "aria-hidden": "true" }, h("span", { class: "nfimp-month__bar" })),
                  h("span", { class: "nfimp-month__n" }, n(m.orders + m.media))
                )
              )
            )
          )
        : null;

    const s = x.skipped;
    const left = [
      s.untitled ? `${count(s.untitled, "Kindle session is", "Kindle sessions are")} for books the export doesn't name, so ${plural(s.untitled, "it's", "they're")} left out.` : "",
      s.future ? `${n(s.future)} ${plural(s.future, "row is", "rows are")} dated after today, so ${plural(s.future, "it's", "they're")} left out.` : "",
      s.free ? `${count(s.free, "free digital item", "free digital items")} (samples and free books) left out.` : "",
    ].filter(Boolean);

    const go = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Import") as HTMLButtonElement;
    go.addEventListener("click", () => {
      rememberImport(MEMO, { at: new Date().toISOString(), items: total, days: new Set([...x.orders.map((o) => o.day), ...x.days.map((d) => d.day)]).size });
      void importView(x, t, plan(x), total);
    });

    const where = (icon: IconName, title: string, meta: string) =>
      h("div", { class: "row row--static" }, h("span", { class: "tile tile--sm" }, icons[icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), h("span", { class: "row__meta" }, meta)));

    show(
      h(
        "div",
        { class: "amzimp-hero" },
        h("span", { class: "amzimp-hero__mark" }, backfillMark("amazon", "lg")),
        h(
          "section",
          { class: "ytimp-found" },
          h("p", { class: "ytimp-found__count" }, n(c.orders || total), h("span", { class: "ytimp-found__unit" }, ` ${c.orders ? plural(c.orders, "order", "orders") : plural(total, "thing", "things")}`)),
          h("p", { class: "ytimp-found__sub" }, first === last ? `On ${longDay(first)}.` : monthYear(first) === monthYear(last) ? `In ${monthYear(first)}.` : `From ${monthYear(first)} to ${monthYear(last)}.`)
        )
      ),
      h("ul", { class: "amzimp-kinds", role: "list", "aria-label": "What's in the export" }, ...tiles),
      recentBlock,
      monthsBlock,
      ...left.map((l) => h("p", { class: "ytimp-found__left" }, l)),
      h(
        "div",
        { class: "card card--flush list ytimp-opts" },
        c.orders || c.digital ? where("parcel", "Orders go into Purchases", "Item names and where each one got to. An order Athena already has from an email gets its items named.") : null,
        x.days.length ? where("calendar", t.collection ? `Reading and watching go into ${t.collection.name}` : "Reading and watching go on your days", "Under Read, Listened and Watched, on the day, with minutes") : null,
        x.finished.length ? where("check", "Finished books go into Watch & read", `${count(x.finished.length, "book", "books")} as read. Ones you've changed stay as they are.`) : null
      ),
      h("div", { class: "ytimp__actions" }, go, h("p", { class: "form__hint ytimp__again" }, "Run it again with a newer export any time. Nothing is added twice.")),
      sample ? h("p", { class: "amzimp-small" }, "This is a made-up export. In sample mode nothing is saved.") : null
    );
    go.focus({ preventScroll: true });
  }

  // ---------- 4. Importing ----------

  async function importView(x: AmazonExport, t: Target, steps: Step[], total: number, from = 0, carried?: Totals) {
    sheet.setTitle(TITLE);
    sheet.setBack(null);
    const totals = carried ?? zero();
    const doneBy = (i: number) => steps.slice(0, i).reduce((k, s) => k + s.size, 0);

    const fill = h("span", { class: "meter__fill" });
    const meter = h("span", { class: "meter ytimp-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-label": "Imported so far" }, fill);
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
      fill.style.setProperty("--p", `${Math.max(2, Math.round((d / Math.max(1, total)) * 1000) / 10)}%`);
      meter.setAttribute("aria-valuenow", String(d));
      meter.setAttribute("aria-valuetext", `${n(d)} of ${n(total)}`);
      now.textContent = steps[i]?.label ?? "Finishing…";
      counter.textContent = `${n(d)} of ${n(total)}`;
    };

    window.addEventListener("beforeunload", beforeUnload);
    let i = from;
    try {
      for (; i < steps.length; i++) {
        paint(i);
        if (stopped || cancelled) break;
        const step = steps[i];
        abort = new AbortController();
        const file = { items: total, days: x.days.length + x.orders.length };
        const r = sample
          ? await new Promise<ReturnType<typeof pretend>>((res) => setTimeout(() => res(pretend(step)), 140))
          : await request<OrdersResult | MediaResult | FinishedResult>(PATH, { method: "POST", body: JSON.stringify({ ...(step.body as object), file }), signal: abort.signal });
        fold(totals, step, r);
      }
      paint(i);
    } catch (err) {
      window.removeEventListener("beforeunload", beforeUnload);
      const lost = !(stopped || (err instanceof DOMException && err.name === "AbortError"));
      if (!lost && !body.isConnected) return;
      stoppedView(x, t, steps, total, i, totals, lost);
      return;
    }
    window.removeEventListener("beforeunload", beforeUnload);
    if (!body.isConnected) return;
    if (stopped && i < steps.length) stoppedView(x, t, steps, total, i, totals, false);
    else doneView(totals, t);
  }

  function fold(totals: Totals, step: Step, r: OrdersResult | MediaResult | FinishedResult) {
    if (step.kind === "orders") {
      const o = r as OrdersResult;
      totals.orders.created += o.created;
      totals.orders.existing += o.existing;
      totals.orders.skipped += o.skipped;
      totals.undo.purchases.push(...o.ids.purchases);
      totals.undo.finance.push(...o.ids.finance);
    } else if (step.kind === "media") {
      const m = r as MediaResult;
      totals.media.added += m.added;
      totals.media.days += m.days_created + m.days_updated;
      for (const s of ["kindle", "audible", "prime_video"] as const) {
        totals.media.by_source[s] += m.by_source[s];
        totals.media.days_by_source[s] += m.days_by_source[s];
      }
      totals.undo.entries.push(...m.ids.entries);
    } else {
      const f = r as FinishedResult;
      totals.finished.created += f.created;
      totals.finished.updated += f.updated;
      totals.undo.watch_read.push(...f.ids.watch_read);
    }
  }

  // ---------- 5. Stopped, or the connection went ----------

  function stoppedView(x: AmazonExport, t: Target, steps: Step[], total: number, upTo: number, totals: Totals, lost: boolean) {
    const saved = steps.slice(0, upTo).reduce((k, s) => k + s.size, 0);
    sheet.setTitle(lost ? "Lost the connection" : "Stopped");
    const carry = h("button", { class: "btn btn--primary btn--block", type: "button" }, lost ? "Try again" : "Carry on") as HTMLButtonElement;
    carry.addEventListener("click", () => void importView(x, t, steps, total, upTo, totals));
    const close = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${lost ? "warn" : "quiet"}`, "aria-hidden": "true" }, lost ? icons.wifiOff() : icons.hourglass()),
        h("p", { class: "ytimp-end__title" }, saved ? `${n(saved)} of ${n(total)} imported` : "Nothing imported yet"),
        h("p", { class: "ytimp-end__sub" }, lost ? "Carry on when you're back online. Nothing is added twice." : "What's imported stays. Carry on now, or import the same zip later: nothing is added twice.")
      ),
      h("div", { class: "ytimp__actions" }, carry, close)
    );
    carry.focus({ preventScroll: true });
  }

  // ---------- 6. The summary, with Undo ----------

  function doneView(r: Totals, t: Target) {
    sheet.setTitle(TITLE);
    const fresh = r.orders.created + r.media.added + r.finished.created;
    if (fresh || r.orders.existing) changed?.();
    const parts = [
      r.orders.created ? count(r.orders.created, "order", "orders") : "",
      r.media.days ? `${count(r.media.days, "day", "days")} of reading and watching` : "",
      !r.orders.created && !r.media.days && r.finished.created ? count(r.finished.created, "finished book", "finished books") : "",
    ].filter(Boolean);

    const line = (icon: IconName, title: string, meta: string) =>
      h("div", { class: "row row--static" }, h("span", { class: "tile tile--sm" }, icons[icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), meta ? h("span", { class: "row__meta" }, meta) : null));
    const rows: HTMLElement[] = [];
    if (r.orders.created || r.orders.existing)
      rows.push(
        line(
          "parcel",
          `${count(r.orders.created + r.orders.existing, "order", "orders")} in Purchases`,
          r.orders.existing ? [r.orders.created ? `${n(r.orders.created)} new` : "", `${n(r.orders.existing)} already there, now with their items named`].filter(Boolean).join(", ") : "Item names and where each one got to"
        )
      );
    const b = r.media.by_source;
    const bd = r.media.days_by_source;
    if (b.kindle) rows.push(line("book", `${count(bd.kindle, "day", "days")} of Kindle reading`, "Under Read on your days"));
    if (b.audible) rows.push(line("mic", `${count(bd.audible, "day", "days")} of Audible listening`, "Under Listened on your days"));
    if (b.prime_video) rows.push(line("tv", count(b.prime_video, "film or episode", "films and episodes"), "From Prime Video, under Watched on your days"));
    if (r.finished.created || r.finished.updated) rows.push(line("check", `${count(r.finished.created + r.finished.updated, "finished book", "finished books")} in Watch & read`, r.finished.updated ? `${n(r.finished.updated)} you had already, marked as read` : ""));

    const extra = [
      r.orders.skipped ? `${count(r.orders.skipped, "order", "orders")} you'd archived ${plural(r.orders.skipped, "was", "were")} left alone.` : "",
    ].filter(Boolean);

    const open = fresh
      ? h("a", { class: "btn btn--primary btn--block", href: r.orders.created ? "#/purchases" : "#/days" }, r.orders.created ? "Open Purchases" : "Open your days")
      : h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    open.addEventListener("click", () => sheet.close());
    const undoable = r.undo.entries.length + r.undo.purchases.length + r.undo.watch_read.length + r.undo.finance.length;
    const undo = h("button", { class: "btn btn--soft btn--block amzimp-undo", type: "button" }, icons.restore(), "Undo this import") as HTMLButtonElement;
    undo.addEventListener("click", () => void undoView(r, t));

    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: `ytimp-end__mark ytimp-end__mark--${fresh ? "good" : "quiet"}`, "aria-hidden": "true" }, icons.check()),
        h("p", { class: "ytimp-end__title" }, fresh ? `Imported ${list(parts)}` : "Nothing new to import"),
        h("p", { class: "ytimp-end__sub" }, fresh ? (t.collection ? `Your days are in ${t.collection.name}.` : "It's all on your days and in Purchases now.") : "Everything in this export was already in Athena."),
        ...extra.map((e) => h("p", { class: "ytimp-end__extra" }, e))
      ),
      rows.length ? h("div", { class: "card card--flush list amzimp-summary" }, ...rows) : null,
      h("div", { class: "ytimp__actions" }, open, undoable ? undo : null, undoable ? h("p", { class: "form__hint ytimp__again" }, "Undo puts away what this import added. Orders and books it only filled in stay as they are.") : null),
      sample ? h("p", { class: "amzimp-small" }, "Sample mode: nothing was saved.") : null
    );
    open.focus({ preventScroll: true });
  }

  async function undoView(r: Totals, t: Target) {
    sheet.setTitle("Undoing");
    sheet.setBack(null);
    show(h("div", { class: "ytimp-busy", role: "status" }, h("span", { class: "meter meter--busy", "aria-hidden": "true" }, h("span", { class: "meter__fill" })), h("p", { class: "ytimp-busy__line" }, "Putting away what this import added…")));
    const u = r.undo;
    const put = { entries: 0, purchases: 0, watch_read: 0 };
    try {
      if (sample) {
        await new Promise((res) => setTimeout(res, 400));
        put.entries = u.entries.length;
        put.purchases = u.purchases.length;
        put.watch_read = u.watch_read.length;
      } else {
        // A request at a time, at most 4,000 things each.
        const chunks: Array<Record<string, unknown>> = [];
        for (let i = 0; i < u.entries.length; i += 4000) chunks.push({ entries: u.entries.slice(i, i + 4000) });
        chunks.push({ purchases: u.purchases.slice(0, 4000), watch_read: u.watch_read, finance: u.finance });
        for (let i = 4000; i < u.purchases.length; i += 4000) chunks.push({ purchases: u.purchases.slice(i, i + 4000) });
        for (const c of chunks) {
          const res = await request<{ entries: number; purchases: number; watch_read: number }>(PATH, { method: "POST", body: JSON.stringify({ part: "undo", ...c }) });
          put.entries += res.entries;
          put.purchases += res.purchases;
          put.watch_read += res.watch_read;
        }
      }
    } catch {
      sheet.setTitle("Couldn't undo");
      const again = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Try again") as HTMLButtonElement;
      again.addEventListener("click", () => void undoView(r, t));
      show(
        h("section", { class: "ytimp-end" }, h("span", { class: "ytimp-end__mark ytimp-end__mark--warn", "aria-hidden": "true" }, icons.wifiOff()), h("p", { class: "ytimp-end__title" }, "Couldn't reach Athena"), h("p", { class: "ytimp-end__sub" }, "Nothing was put away yet. Try again when you're online.")),
        h("div", { class: "ytimp__actions" }, again)
      );
      return;
    }
    changed?.();
    sheet.setTitle(TITLE);
    const close = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    close.addEventListener("click", () => sheet.close());
    const what = [put.purchases ? count(put.purchases, "order", "orders") : "", put.entries ? count(put.entries, "day entry", "day entries") : "", put.watch_read ? count(put.watch_read, "book", "books") : ""].filter(Boolean);
    show(
      h(
        "section",
        { class: "ytimp-end" },
        h("span", { class: "ytimp-end__mark ytimp-end__mark--quiet", "aria-hidden": "true" }, icons.archive()),
        h("p", { class: "ytimp-end__title" }, "Import undone"),
        h("p", { class: "ytimp-end__sub" }, what.length ? `Put away ${list(what)}.${put.purchases || put.watch_read ? " Orders and books are in Archived if you want any back." : ""}` : "There was nothing left to put away.")
      ),
      h("div", { class: "ytimp__actions" }, close)
    );
    close.focus({ preventScroll: true });
  }

  stepsView();
}
