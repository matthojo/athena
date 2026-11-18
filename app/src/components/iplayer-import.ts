/**
 * "Import your iPlayer history": what you watched on BBC iPlayer and when,
 * from the copy of your BBC account data. Opened from iPlayer's card in
 * Sources (views/connect.ts FILE_IMPORTS).
 *
 * The CSVs (or their zip) are read here (lib/iplayer-export.ts). Each
 * programme becomes a Watched entry on its day, and each series and film
 * goes into Watch & read, as Netflix's do: a series as watching until you
 * say it's done. News, weather and live channels stay on your days only.
 * The flow is the shared one in download-import.ts.
 */
import { h } from "../lib/dom";
import { plural } from "../lib/format";
import { backfillMark } from "./backfill-marks";
import { chips, count, duration, listOf, longDay, monthYear, n, openDownloadImport, ranked, tile, where, type Batch, type DaysResult } from "./download-import";
import { sampleIplayerExport } from "../lib/iplayer-sample";
import { batchWatchDays, NOT_FOR_WATCH_READ, parseIplayer, sniffIplayer, type IplayerExport, type WatchDay } from "../../../lib/iplayer-export";
import { iplayerId } from "../../../lib/day-imports";
import { titleKey } from "../../../lib/netflix-csv";
import "../styles/iplayer-import.css";

export function openIplayerImport(changed?: () => void): void {
  openDownloadImport<IplayerExport>(
    {
      format: "iplayer",
      title: "Import your iPlayer history",
      mark: () => backfillMark("iplayer", "lg"),
      lede: "The BBC keeps what you've watched on iPlayer, and it will send you a copy. Athena puts each programme on the day you watched it.",
      steps: [
        { title: "Ask the BBC for your data", sub: "Sign in to your BBC account, then choose Download your data under Settings.", open: "https://account.bbc.com/account/settings" },
        { title: "Wait for the email", sub: "It usually comes within a day." },
        { title: "Download the files", sub: "Save the zip, or the CSV files on their own." },
      ],
      choose: "Choose the files",
      dropSub: "The zip from the BBC, or the CSV files inside it. Add them all at once.",
      privacy: "Athena reads the files on this device. It sends what you watched, when, and for how long. Your name, address and licence details stay here.",
      problems: {
        notFile: "That isn't the BBC's data file. Choose the zip or the CSV files from your BBC account download.",
        nothing: "There's no iPlayer viewing in those files. Check they're from your BBC account download, not BBC Sounds.",
      },
      sample: () => sampleIplayerExport(),
      sniff: sniffIplayer,
      parse: (files, o) => parseIplayer(files, { ...o, tz: o.tz || "Europe/London" }),
      readingLine: "Reading what you watched…",
      isEmpty: (x) => !x.range,
      preview: (x, t) => {
        const c = x.counts;
        const { first, last } = x.range!;
        const series = new Set(x.days.flatMap((d) => d.programmes.filter((p) => !p.film).map((p) => titleKey(p.title))));
        const films = new Set(x.days.flatMap((d) => d.programmes.filter((p) => p.film).map((p) => titleKey(p.title))));
        const keep = new Set(x.days.flatMap((d) => d.programmes.filter((p) => !NOT_FOR_WATCH_READ.test(p.title)).map((p) => titleKey(p.title))));
        const tiles = [
          tile("days", "calendar", n(c.days), `${plural(c.days, "day", "days")} watching`, `${count(c.watches, "sitting", "sittings")}`, 0),
          tile("hours", "clock", n(c.minutes >= 90 ? Math.round(c.minutes / 60) : c.minutes), c.minutes >= 90 ? plural(Math.round(c.minutes / 60), "hour", "hours") : plural(c.minutes, "minute", "minutes"), "on iPlayer", 1),
          tile("programmes", "tv", n(c.programmes), plural(c.programmes, "programme", "programmes"), [series.size ? count(series.size, "series", "series") : "", films.size ? count(films.size, "film", "films") : ""].filter(Boolean).join(", "), 2),
        ];
        const top = ranked(
          "What you watched most",
          x.top.slice(0, 5).map((p) => ({ name: p.title, value: p.minutes || p.episodes, meta: p.minutes ? duration(p.minutes) : count(p.episodes, "episode", "episodes"), sub: count(p.episodes, "episode", "episodes") })),
          "iplayer"
        );
        // The latest few, newest first: proof it's your account.
        const lately = x.days
          .slice()
          .reverse()
          .flatMap((d) => d.programmes)
          .filter((p, i, all) => all.findIndex((q) => titleKey(q.title) === titleKey(p.title)) === i)
          .slice(0, 6)
          .map((p) => ({ text: p.title, title: p.episode ? `${p.title}, ${p.episode}` : p.title }));
        const left = [
          x.skipped.short ? `${count(x.skipped.short, "watch under a minute was", "watches under a minute were")} left out.` : "",
          x.skipped.other ? `${count(x.skipped.other, "row from another BBC service was", "rows from other BBC services were")} left out.` : "",
          x.skipped.future ? `${count(x.skipped.future, "row is", "rows are")} dated after today, so left out.` : "",
        ].filter(Boolean);
        return {
          headline: h(
            "section",
            { class: "ytimp-found" },
            h("p", { class: "ytimp-found__count" }, n(c.programmes), h("span", { class: "ytimp-found__unit" }, ` ${plural(c.programmes, "programme", "programmes")}`)),
            h("p", { class: "ytimp-found__sub" }, first === last ? `On ${longDay(first)}.` : `${monthYear(first) === monthYear(last) ? `In ${monthYear(first)}` : `From ${monthYear(first)} to ${monthYear(last)}`}.`)
          ),
          blocks: [h("ul", { class: "amzimp-kinds dlimp-kinds", role: "list", "aria-label": "What's in the file" }, ...tiles), top, chips("Lately", lately), ...left.map((l) => h("p", { class: "ytimp-found__left" }, l))],
          where: [
            where("calendar", t.collection ? `Programmes go into ${t.collection.name}` : "Programmes go on your days", "Under Watched, on the day, with minutes"),
            keep.size ? where("tv", "Series and films go into Watch & read", `${count(keep.size, "title", "titles")}. A series stays Watching until you mark it done. News and weather stay out.`) : null,
          ],
          items: c.watches,
          days: c.days,
        };
      },
      batches: (x) => batchWatchDays(x.days).map((b) => ({ days: b, size: b.reduce((k, d) => k + d.programmes.length, 0) })),
      batchLabel: (b) => `Adding ${monthYear(b.days[0].day)} to your days`,
      pretend: (b: Batch): DaysResult => {
        const days = b.days as WatchDay[];
        const progs = days.flatMap((d) => d.programmes.map((p) => ({ ...p, day: d.day })));
        const titles = new Set(progs.filter((p) => !NOT_FOR_WATCH_READ.test(p.title)).map((p) => titleKey(p.title)));
        return {
          days_created: days.length,
          days_updated: 0,
          days_unchanged: 0,
          days_skipped: 0,
          added: progs.length,
          days_added: days.length,
          minutes_added: progs.reduce((k, p) => k + (p.minutes ?? 0), 0),
          skipped_lastfm: 0,
          watch_read: { created: titles.size, updated: 0 },
          ids: { entries: progs.map((p) => iplayerId(p.day, p.key)), watch_read: [...titles].map((k) => `sample-${k}`) },
        };
      },
      summary: (r, t) => {
        const parts = [r.days ? `${count(r.days, "day", "days")} of watching` : "", !r.days && r.watchRead.created ? count(r.watchRead.created, "title", "titles") : ""].filter(Boolean);
        return {
          title: parts.length ? `Imported ${listOf(parts)}` : "Nothing new to import",
          sub: parts.length ? (t.collection ? `It's in ${t.collection.name} now.` : "It's on your days now.") : "Everything in these files was already in Athena.",
          rows: [
            ...(r.added ? [where("tv", `${count(r.added, "programme", "programmes")} on ${count(r.days, "day", "days")}`, r.minutes ? `${duration(r.minutes)} of iPlayer, under Watched` : "Under Watched on your days")] : []),
            ...(r.watchRead.created || r.watchRead.updated
              ? [where("film", `${count(r.watchRead.created + r.watchRead.updated, "series or film", "series and films")} in Watch & read`, r.watchRead.updated ? `${n(r.watchRead.updated)} you had already, left as they were` : "Series as watching, films as watched")]
              : []),
          ],
          open: { href: r.added ? "#/days" : "#/reading", label: r.added ? "Open your days" : "Open Watch & read" },
        };
      },
      undoLine: (put) => {
        const what = [put.entries ? count(put.entries, "programme", "programmes") : "", put.watch_read ? count(put.watch_read, "Watch & read title", "Watch & read titles") : ""].filter(Boolean);
        return what.length ? `Put away ${listOf(what)}.${put.watch_read ? " Titles are in Archived if you want any back." : ""}` : "There was nothing left to put away.";
      },
    },
    changed
  );
}
