/**
 * "Import your Spotify streaming history": every play, with its time, from
 * the Extended streaming history Spotify sends (Account → Privacy). Opened
 * from its card in Sources (views/connect.ts FILE_IMPORTS).
 *
 * The file is read here (lib/spotify-history.ts): the zip, or the
 * Streaming_History_Audio JSON files inside it. Plays under 30 seconds,
 * podcasts and audiobooks are left out; the rest become one Listened entry
 * per album a day, with plays per hour for Music's "When you listen". What
 * Last.fm already has is left to Last.fm. The flow is download-import.ts's.
 */
import { h } from "../lib/dom";
import { plural } from "../lib/format";
import { backfillMark } from "./backfill-marks";
import { chips, count, duration, longDay, monthYear, n, openDownloadImport, ranked, tile, where, type Batch, type DaysResult } from "./download-import";
import { batchSpotifyDays, parseSpotifyHistory, sniffSpotifyName, type SpotifyDay, type SpotifyHistory } from "../../../lib/spotify-history";
import { albumDayId } from "../../../lib/day-imports";
import "../styles/apple-music-import.css";

const hoursOf = (minutes: number) => (minutes >= 90 ? Math.round(minutes / 60) : minutes);

/** A small made-up history for sample mode: a few weeks of plays, a skip and a podcast. */
function sampleFile(): Array<{ name: string; text: string }> {
  const albums = [
    ["Tidal Hours", "Mara Vell"],
    ["Amber Signals", "Ostra"],
    ["Soft Neon", "Kaito Rhee"],
    ["Winter Index", "Halden"],
    ["Concrete Garden", "The Low Arcs"],
  ];
  const rows: unknown[] = [];
  const start = Date.UTC(2026, 8, 1);
  // Favourites get most of the plays, as they do: Mara Vell far ahead, The Low Arcs now and then.
  const weights = [9, 5, 3, 2, 1];
  const pick = (x: number) => {
    let left = x * weights.reduce((a, b) => a + b, 0);
    return albums[weights.findIndex((w) => (left -= w) < 0)] ?? albums[0];
  };
  for (let d = 0; d < 40; d++) {
    for (let i = 0; i < 8 + (d % 5); i++) {
      const [album, artist] = pick(((d * 7 + i * 13) % 29) / 29);
      const hour = [8, 8, 13, 19, 20, 21, 21, 22][i % 8];
      const ms = i === 5 ? 12_000 : 150_000 + ((d * 31 + i * 17) % 9) * 15_000;
      rows.push({ ts: new Date(start + d * 86_400_000 + hour * 3_600_000 + i * 240_000).toISOString().replace(".000", ""), ms_played: ms, master_metadata_track_name: `Track ${i + 1}`, master_metadata_album_artist_name: artist, master_metadata_album_album_name: album, spotify_track_uri: `spotify:track:${d}${i}`, skipped: i === 5 });
    }
    if (d % 7 === 0) rows.push({ ts: new Date(start + d * 86_400_000 + 7 * 3_600_000).toISOString(), ms_played: 1_800_000, master_metadata_track_name: null, episode_name: "Episode 12", spotify_episode_uri: "spotify:episode:x" });
  }
  return [{ name: "Spotify Extended Streaming History/Streaming_History_Audio_2026_0.json", text: JSON.stringify(rows) }];
}

export function openSpotifyHistoryImport(changed?: () => void): void {
  openDownloadImport<SpotifyHistory>(
    {
      format: "spotify_history",
      title: "Import your Spotify history",
      mark: () => backfillMark("spotify_history", "lg"),
      lede: "Spotify keeps every song you've streamed, with the time you played it, and will send you a copy. Athena puts what you listened to on each of your days, and Music shows when you listen.",
      steps: [
        { title: "Request it from Spotify", sub: "Account → Privacy → Extended streaming history. Tick only that box and request it.", open: "https://www.spotify.com/account/privacy/" },
        { title: "Wait for the email", sub: "Spotify says it can take up to 30 days, often less." },
        { title: "Download the zip", sub: "Use the link in Spotify's email. There's no need to open it." },
      ],
      choose: "Choose the file",
      dropSub: "The zip from Spotify, or the Streaming_History_Audio files inside it.",
      privacy: "Athena reads the file on this device. It sends the albums, artists, plays, minutes and hours for each day, nothing else from your Spotify account.",
      problems: {
        notFile: "That isn't Spotify's streaming history. Choose the zip from Spotify's email, or the Streaming_History_Audio files inside it.",
        nothing: "There are no songs in that file. Check it's the Extended streaming history, not Account data.",
      },
      sample: sampleFile,
      sniff: () => null,
      byName: sniffSpotifyName,
      parse: (files, o) => parseSpotifyHistory(files, o),
      readingLine: "Reading your plays…",
      isEmpty: (x) => !x.range,
      preview: (x, t) => {
        const c = x.counts;
        const { first, last } = x.range!;
        const tiles = [
          tile("days", "calendar", n(c.days), `${plural(c.days, "day", "days")} listening`, count(c.albums, "album", "albums"), 0),
          tile("hours", "clock", n(hoursOf(c.minutes)), c.minutes >= 90 ? `${plural(hoursOf(c.minutes), "hour", "hours")} of music` : `${plural(c.minutes, "minute", "minutes")} of music`, `about ${duration(Math.round(c.minutes / Math.max(1, c.days)))} a day`, 1),
          tile("artists", "music", n(c.artists), plural(c.artists, "artist", "artists"), x.top.artists[0] ? `${x.top.artists[0].name} most of all` : "", 2),
        ];
        const top = ranked(
          "Your top artists",
          x.top.artists.slice(0, 5).map((a) => ({ name: a.name, value: a.minutes, meta: duration(a.minutes), sub: count(a.plays, "play", "plays") })),
          "apple"
        );
        const repeat = chips(
          "Albums on repeat",
          x.top.albums.slice(0, 6).map((a) => ({ text: a.name, title: a.artist ? `${a.name}, ${a.artist}` : a.name }))
        );
        const left = [
          x.skipped.short ? `${count(x.skipped.short, "play under 30 seconds was", "plays under 30 seconds were")} left out as ${plural(x.skipped.short, "a skip", "skips")}.` : "",
          x.skipped.podcasts ? `${count(x.skipped.podcasts, "podcast or audiobook play", "podcast and audiobook plays")} left out.` : "",
          x.skipped.future ? `${count(x.skipped.future, "play is", "plays are")} dated after today, so left out.` : "",
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
            where("calendar", t.collection ? `Albums go into ${t.collection.name}` : "Albums go on your days", "Under Listened, one per album a day, with plays, minutes and the hours you played them"),
            where("music", "Last.fm comes first", "If Last.fm already has an album on a day, Athena keeps Last.fm's. Days your Life log already wrote just gain the times."),
          ],
          items: c.plays,
          days: c.days,
        };
      },
      batches: (x) => batchSpotifyDays(x.days).map((b) => ({ days: b, size: b.reduce((k, d) => k + d.albums.length, 0) })),
      batchLabel: (b) => `Adding ${monthYear(b.days[0].day)} to your days`,
      pretend: (b: Batch): DaysResult => {
        const days = b.days as SpotifyDay[];
        const albums = days.flatMap((d) => d.albums.map((a) => ({ ...a, day: d.day })));
        return {
          days_created: days.length,
          days_updated: 0,
          days_unchanged: 0,
          days_skipped: 0,
          added: albums.length,
          days_added: days.length,
          minutes_added: albums.reduce((k, a) => k + a.minutes, 0),
          skipped_lastfm: 0,
          watch_read: { created: 0, updated: 0 },
          ids: { entries: albums.map((a) => albumDayId(a.day, a.title, a.artist)), watch_read: [] },
        };
      },
      summary: (r, t) => ({
        title: r.added ? `Imported ${count(r.days, "day", "days")} of listening` : "Nothing new to import",
        sub: r.added ? (t.collection ? `${duration(r.minutes)} of music, now in ${t.collection.name}.` : `${duration(r.minutes)} of music, now on your days.`) : "Every album in this file was already on your days.",
        rows: [
          ...(r.added ? [where("music", `${count(r.added, "album", "albums")} on ${count(r.days, "day", "days")}`, "Under Listened, with plays, minutes and times")] : []),
          ...(r.skippedLastfm ? [where("check", `${count(r.skippedLastfm, "album", "albums")} left to Last.fm`, "Last.fm already had them on those days")] : []),
        ],
        open: { href: "#/music", label: "Open Music" },
      }),
      undoLine: (put) => (put.entries ? `Put away ${count(put.entries, "album", "albums")} from your days.` : "There was nothing left to put away."),
    },
    changed
  );
}
