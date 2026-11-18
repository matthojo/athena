/**
 * "Import your Apple Music history": what you listened to, day by day, from
 * the copy of your data privacy.apple.com sends. Opened from Apple Music's
 * card in Sources (views/connect.ts FILE_IMPORTS).
 *
 * The file is read here (lib/apple-music-export.ts): the zip or the CSV,
 * either of Apple's two layouts, in steps so a big history doesn't freeze
 * the page. Each song becomes a Listened entry on its day; a song Last.fm
 * already logged that day is left to Last.fm. The flow is the shared one in
 * download-import.ts; this file brings the words and the preview.
 */
import { h } from "../lib/dom";
import { plural } from "../lib/format";
import { backfillMark } from "./backfill-marks";
import { chips, count, duration, longDay, monthYear, n, openDownloadImport, ranked, tile, where, type Batch, type DaysResult } from "./download-import";
import { sampleAppleMusicExport } from "../lib/apple-music-sample";
import { batchListenDays, parseAppleMusic, sniffApple, type AppleMusicExport, type ListenDay } from "../../../lib/apple-music-export";
import { appleMusicId } from "../../../lib/day-imports";
import "../styles/apple-music-import.css";

const hoursOf = (minutes: number) => (minutes >= 90 ? Math.round(minutes / 60) : minutes);

export function openAppleMusicImport(changed?: () => void): void {
  openDownloadImport<AppleMusicExport>(
    {
      format: "apple_music",
      title: "Import your Apple Music history",
      mark: () => backfillMark("apple_music", "lg"),
      lede: "Apple Music keeps every song you've played, and Apple will send you a copy. Athena puts what you listened to on each of your days.",
      steps: [
        { title: "Ask Apple for a copy of your data", sub: "Sign in, choose Request a copy of your data, then tick Apple Media Services.", open: "https://privacy.apple.com/" },
        { title: "Wait for the email", sub: "Apple checks it's you first. It usually takes up to a week." },
        { title: "Download the zip", sub: "Use the link in Apple's email. There's no need to open it." },
      ],
      choose: "Choose the file",
      dropSub: "The zip from Apple, or the Apple Music CSV inside it.",
      privacy: "Athena reads the file on this device. It sends the songs, artists and minutes for each day, nothing else from your Apple account.",
      problems: {
        notFile: "That isn't Apple's data file. Choose the zip from privacy.apple.com, or the Apple Music Play Activity CSV inside it.",
        nothing: "There are no songs in that file. Check it's the Apple Media Services part of your data.",
      },
      sample: () => sampleAppleMusicExport(),
      sniff: sniffApple,
      parse: (files, o) => parseAppleMusic(files, o),
      readingLine: "Reading your songs…",
      isEmpty: (x) => !x.range,
      preview: (x, t) => {
        const c = x.counts;
        const { first, last } = x.range!;
        const tiles = [
          tile("days", "calendar", n(c.days), `${plural(c.days, "day", "days")} listening`, `${count(c.tracks, "different song", "different songs")}`, 0),
          tile("hours", "clock", n(hoursOf(c.minutes)), c.minutes >= 90 ? `${plural(hoursOf(c.minutes), "hour", "hours")} of music` : `${plural(c.minutes, "minute", "minutes")} of music`, `about ${duration(Math.round(c.minutes / Math.max(1, c.days)))} a day`, 1),
          tile("artists", "music", n(c.artists), plural(c.artists, "artist", "artists"), x.top.artists[0] ? `${x.top.artists[0].name} most of all` : `${count(c.tracks, "song", "songs")}`, 2),
        ];
        const top = ranked(
          "Your top artists",
          x.top.artists.slice(0, 5).map((a) => ({ name: a.name, value: a.minutes, meta: duration(a.minutes), sub: count(a.plays, "play", "plays") })),
          "apple"
        );
        const repeat = chips(
          "On repeat",
          x.top.tracks.slice(0, 6).map((s) => ({ text: s.name, title: s.artist ? `${s.name}, ${s.artist}` : s.name }))
        );
        const left = [
          x.skipped.short ? `${count(x.skipped.short, "play under 30 seconds was", "plays under 30 seconds were")} left out as ${plural(x.skipped.short, "a skip", "skips")}.` : "",
          x.skipped.video ? `${count(x.skipped.video, "music video", "music videos")} left out.` : "",
          x.skipped.future ? `${count(x.skipped.future, "row is", "rows are")} dated after today, so left out.` : "",
        ].filter(Boolean);
        return {
          headline: h(
            "section",
            { class: "ytimp-found" },
            h("p", { class: "ytimp-found__count" }, n(c.plays), h("span", { class: "ytimp-found__unit" }, ` ${plural(c.plays, "play", "plays")}`)),
            h("p", { class: "ytimp-found__sub" }, first === last ? `On ${longDay(first)}.` : `${monthYear(first) === monthYear(last) ? `In ${monthYear(first)}` : `From ${monthYear(first)} to ${monthYear(last)}`}.`)
          ),
          blocks: [h("ul", { class: "amzimp-kinds dlimp-kinds", role: "list", "aria-label": "What's in the file" }, ...tiles), top, repeat, ...left.map((l) => h("p", { class: "ytimp-found__left" }, l))],
          where: [
            where("calendar", t.collection ? `Songs go into ${t.collection.name}` : "Songs go on your days", "Under Listened, on the day, with minutes and plays"),
            where("music", "Last.fm comes first", "If Last.fm already has a song on a day, Athena keeps Last.fm's and leaves Apple's out."),
          ],
          items: c.plays,
          days: c.days,
        };
      },
      batches: (x) => batchListenDays(x.days).map((b) => ({ days: b, size: b.reduce((k, d) => k + d.tracks.length, 0) })),
      batchLabel: (b) => `Adding ${monthYear(b.days[0].day)} to your days`,
      pretend: (b: Batch): DaysResult => {
        const days = b.days as ListenDay[];
        const tracks = days.flatMap((d) => d.tracks.map((t) => ({ ...t, day: d.day })));
        return {
          days_created: days.length,
          days_updated: 0,
          days_unchanged: 0,
          days_skipped: 0,
          added: tracks.length,
          days_added: days.length,
          minutes_added: tracks.reduce((k, t) => k + t.minutes, 0),
          skipped_lastfm: 0,
          watch_read: { created: 0, updated: 0 },
          ids: { entries: tracks.map((t) => appleMusicId(t.day, t.key)), watch_read: [] },
        };
      },
      summary: (r, t) => ({
        title: r.added ? `Imported ${count(r.days, "day", "days")} of listening` : "Nothing new to import",
        sub: r.added ? (t.collection ? `${duration(r.minutes)} of music, now in ${t.collection.name}.` : `${duration(r.minutes)} of music, now on your days.`) : "Every song in this file was already on your days.",
        rows: [
          ...(r.added ? [where("music", `${count(r.added, "song", "songs")} on ${count(r.days, "day", "days")}`, "Under Listened, with minutes and plays")] : []),
          ...(r.skippedLastfm ? [where("check", `${count(r.skippedLastfm, "song", "songs")} left to Last.fm`, "Last.fm already had them on those days")] : []),
        ],
        open: { href: "#/days", label: "Open your days" },
      }),
      undoLine: (put) => (put.entries ? `Put away ${count(put.entries, "song", "songs")} from your days.` : "There was nothing left to put away."),
    },
    changed
  );
}
