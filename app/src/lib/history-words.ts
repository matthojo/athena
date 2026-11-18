/** What the history row says (components/history-load.ts). Pure, so the tests can read it. */

export interface HistoryProgress {
  state: "running" | "waiting" | "done" | "failed" | "blocked";
  items: number;
  added: number;
  oldest?: string;
  capped?: boolean;
  error?: string;
  finished_at?: string;
  /** "day": each item is a day of readings (Octopus). */
  unit?: "day";
}

export interface HistoryStatus {
  supported: boolean;
  progress: HistoryProgress | null;
  /** YouTube: a Takeout import already in. */
  takeout: { at: string; items: number } | null;
}

const n = (x: number) => x.toLocaleString("en-GB");
const monthYear = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** What the row says for where the load is. */
export function historyWords(p: HistoryProgress | null, service: string): { title: string; meta: string; busy: boolean } {
  if (!p) return { title: "History not loaded yet", meta: `Athena loads your ${service} history when you connect it`, busy: false };
  const one = p.unit === "day" ? "day" : "item";
  const count = (x: number) => `${n(x)} ${x === 1 ? one : `${one}s`}`;
  const sofar = p.items ? `Loading your history… ${count(p.items)} so far` : "Loading your history…";
  if (p.state === "running") return { title: sofar, meta: "It carries on if you close this", busy: true };
  if (p.state === "waiting") return { title: sofar, meta: p.error ? `${p.error} Athena carries on after that.` : `${service} asked Athena to wait. It carries on within the hour.`, busy: true };
  if (p.state === "blocked") return { title: "Choose what Athena can read to load your history", meta: "Allow a read below and it starts", busy: false };
  if (p.state === "failed") return { title: "Couldn't load your history", meta: p.error ?? "Something went wrong. Try loading it again.", busy: false };
  const title = p.oldest ? `History loaded back to ${monthYear(p.oldest)}` : "History loaded";
  const parts = [p.items ? count(p.items) : "Nothing older to load"];
  if (p.capped) parts.push("the most recent ones");
  // A day of readings saved again isn't "new": Octopus says only how many days.
  if (p.added && p.unit !== "day") parts.push(`${n(p.added)} new to Athena`);
  return { title, meta: parts.join(" · "), busy: false };
}
