/**
 * A made-up Apple Music data copy for sample mode (components/apple-music-
 * import.ts): a "Play History Daily Tracks" file shaped like Apple's, about
 * eighteen months of listening ending yesterday, a few days of the older
 * Play Activity file, and a store file the import passes over. Seeded, so
 * the preview and screenshots are the same every time.
 */

/** Artist, then songs as [title, minutes]. Weighted: earlier artists come up more. */
const ARTISTS: Array<[string, Array<[string, number]>]> = [
  ["Arlo Parks", [["Black Dog", 4], ["Hurt", 3.5], ["Caroline", 4], ["Softly", 3]]],
  ["Radiohead", [["Weird Fishes/Arpeggi", 5.3], ["Reckoner", 4.8], ["Nude", 4.3], ["No Surprises", 3.8]]],
  ["Little Simz", [["Venom", 3.2], ["Introvert", 6.2], ["Gorilla", 3.3]]],
  ["Phoebe Bridgers", [["Motion Sickness", 3.8], ["Kyoto", 3.1], ["Garden Song", 3.6]]],
  ["Khruangbin", [["Maria También", 3.3], ["Time (You and I)", 4.3], ["August 10", 4.2]]],
  ["Florence + the Machine", [["Dog Days Are Over", 4.2], ["Shake It Out", 4.6]]],
  ["Bon Iver", [["Holocene", 5.6], ["Skinny Love", 3.9]]],
  ["Fred again..", [["Delilah (pull me out of this)", 4.3], ["Marea (we've lost dancing)", 4.6]]],
  ["Nina Simone", [["Feeling Good", 2.9], ["Sinnerman", 10.3]]],
  ["Self Esteem", [["I Do This All The Time", 5], ["Prioritise Pleasure", 4.1]]],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const row = (cells: Array<string | number>) => cells.map(q).join(",");

export interface SampleFile {
  name: string;
  text: string;
}

export function sampleAppleMusicExport(today = new Date()): SampleFile[] {
  const r = rng(20261109);
  const day = (back: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const daily = [row(["Country", "Track Identifier", "Media type", "Date Played", "Hours", "Play Duration Milliseconds", "Source Type", "Play Count", "Skip Count", "Ignore For Recommendations", "Track Reference", "Track Description"])];
  for (let back = 540; back >= 1; back--) {
    // Most days some music; weekends more; the odd quiet week.
    const d = day(back);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (r() > (weekend ? 0.85 : 0.62)) continue;
    const songs = 2 + Math.floor(r() * (weekend ? 9 : 6));
    for (let i = 0; i < songs; i++) {
      const a = ARTISTS[Math.min(ARTISTS.length - 1, Math.floor(r() ** 1.8 * ARTISTS.length))];
      const [title, mins] = a[1][Math.floor(r() * a[1].length)];
      const plays = r() < 0.25 ? 2 : 1;
      const skipped = r() < 0.08;
      const ms = skipped ? 9000 + Math.floor(r() * 15000) : Math.round(mins * 60_000 * plays * (0.85 + r() * 0.15));
      daily.push(row(["GB", 1_100_000_000 + i, "AUDIO", ymd(d), String(7 + Math.floor(r() * 15)), ms, "IPHONE", plays, skipped ? 1 : 0, "", 1_100_000_000 + i, `${a[0]} - ${title}`]));
    }
  }
  return [
    { name: "Apple Media Services information/Apple Music - Play History Daily Tracks.csv", text: daily.join("\n") },
    { name: "Apple Media Services information/Store Transaction History.csv", text: `${row(["Item Description", "Purchase Date", "Price"])}\n${row(["A sample app", "2025-01-01", "0.99"])}` },
  ];
}
