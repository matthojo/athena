/**
 * A made-up BBC account data download for sample mode (components/iplayer-
 * import.ts): the iPlayer viewing file, shaped the way the importer reads
 * it, about nine months ending yesterday, with a Sounds row and an account
 * file it passes over. Seeded, so the preview is the same every time.
 */

/** Programme, series, episode titles. A film has no series. */
const SHOWS: Array<[string, string, string[]]> = [
  ["Doctor Who", "Series 14", ["Space Babies", "The Devil's Chord", "Boom", "73 Yards", "Dot and Bubble", "Rogue", "The Legend of Ruby Sunday", "Empire of Death"]],
  ["The Traitors", "Series 3", ["Episode 1", "Episode 2", "Episode 3", "Episode 4", "Episode 5", "Episode 6", "Episode 7", "Episode 8", "Episode 9", "Episode 10", "Episode 11", "Episode 12"]],
  ["Blue Lights", "Series 2", ["Episode 1", "Episode 2", "Episode 3", "Episode 4", "Episode 5", "Episode 6"]],
  ["Gardeners' World", "2026", ["Episode 3", "Episode 4", "Episode 5", "Episode 6", "Episode 7", "Episode 8", "Episode 9"]],
  ["Rivals", "Series 1", ["Episode 1", "Episode 2", "Episode 3", "Episode 4"]],
  ["Race Across the World", "Series 5", ["Episode 1", "Episode 2", "Episode 3", "Episode 4", "Episode 5"]],
  ["Mr Bates vs The Post Office", "Series 1", ["Episode 1", "Episode 2", "Episode 3", "Episode 4"]],
];
const FILMS = ["Paddington 2", "Aftersun", "Living"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const row = (cells: Array<string | number>) => cells.map(q).join(",");
const pid = (n: number) => `m0${n.toString(36).padStart(6, "0")}`;

export interface SampleFile {
  name: string;
  text: string;
}

export function sampleIplayerExport(today = new Date()): SampleFile[] {
  const r = rng(20261110);
  const at = (back: number, hour: number) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back, hour, Math.floor(r() * 50)));
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const rows = [row(["Programme Title", "Series Title", "Episode Title", "Episode PID", "Date Watched", "Duration Watched (seconds)", "Product"])];
  let n = 1000;
  let back = 270;
  for (const [show, series, eps] of SHOWS) {
    const base = n;
    n += 50;
    for (const [i, ep] of eps.entries()) {
      back -= 1 + Math.floor(r() * 4);
      if (back < 1) break;
      rows.push(row([show, series, ep, pid(base + i), at(back, 19 + Math.floor(r() * 3)), 2400 + Math.floor(r() * 1200), "iPlayer"]));
      if (r() < 0.3 && i + 1 < eps.length) rows.push(row([show, series, eps[i + 1], pid(base + i + 1), at(back, 22), 1800 + Math.floor(r() * 900), "iPlayer"]));
    }
    back += 28 + Math.floor(r() * 20);
  }
  for (const [i, f] of FILMS.entries()) rows.push(row([f, "", "", pid(n + i), at(20 + i * 61, 15), 5400 + Math.floor(r() * 900), "iPlayer"]));
  rows.push(row(["BBC News at Six", "", "", pid(n + 10), at(3, 18), 1500, "iPlayer"]));
  rows.push(row(["Desert Island Discs", "", "Dolly Parton", pid(n + 11), at(6, 9), 2400, "Sounds"]));
  return [
    { name: "BBC account data/iPlayer Viewing History.csv", text: rows.join("\n") },
    { name: "BBC account data/Account Information.csv", text: "Field,Value\nDisplay name,Sam\n" },
  ];
}
