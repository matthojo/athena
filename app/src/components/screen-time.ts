/**
 * Screen time: the last week, month or quarter of watching, set against the
 * same stretch before it. Opened from Watch & read's month card.
 *
 * Each day as a column; a usual week as a grid of weekday by half hour,
 * darker where more is watched; then the
 * figures (a day's average, the total, the share of waking hours, films,
 * shows and videos), each with how it moved. More watching isn't better or
 * worse, so a change is plain ink, never green or red.
 *
 * The numbers are lib/watch-stats.ts's: time covers the plays whose length
 * is known, and the sheet says so when that isn't all of them.
 */
import { h } from "../lib/dom";
import { openSheet } from "./sheet";
import { barChart, heatmap } from "./house-charts";
import { loadScreenTime } from "../db/days-app";
import { minutesWords } from "../../../lib/watch-meta";
import { DAY_PARTS, type ScreenTime, type StatItem } from "../../../lib/watch-stats";
import "../styles/house.css";
import "../styles/screen-time.css";

const SPANS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const dayOf = (date: string) => new Date(`${date}T12:00:00`);
const short = (date: string) => dayOf(date).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "+1h 14m", "−20m", "No change": how a figure moved from the stretch before. */
function moved(now: number, before: number, words: (n: number) => string): string {
  const d = now - before;
  return d === 0 ? "No change" : `${d > 0 ? "+" : "−"}${words(Math.abs(d))}`;
}

function tile(label: string, value: string, change: string): HTMLElement {
  return h("div", { class: "st-tile" }, h("dt", { class: "st-tile__label" }, label), h("dd", { class: "st-tile__value" }, value), h("dd", { class: "st-tile__change" }, change));
}

function body(st: ScreenTime, days: number): HTMLElement[] {
  const byTime = st.total > 0;
  const today = st.to;
  const chart = barChart({
    label: `${byTime ? "Time watched" : "Watched"} each day, ${short(st.from)} to today`,
    series: [{ name: byTime ? "Watched" : "Plays", cls: "is-watch" }],
    points: st.days.map((d, i) => {
      const date = dayOf(d.date);
      const tick = days <= 7 ? (d.date === today ? "Today" : date.toLocaleDateString(undefined, { weekday: "narrow" })) : i === 0 || i === st.days.length - 1 || date.getDate() === 1 || (days <= 30 && date.getDay() === 1) ? short(d.date) : undefined;
      return { label: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), tick, values: [byTime ? d.minutes : d.plays] };
    }),
    format: (v) => (byTime ? (v ? minutesWords(v) : "Nothing") : `${v} watched`),
    note: (i) => (byTime && st.days[i].plays ? `${st.days[i].plays} watched` : ""),
    height: 168,
  });
  const most = st.days.reduce((a, b) => ((byTime ? b.minutes > a.minutes : b.plays > a.plays) ? b : a), st.days[0]);
  const peak = (byTime ? most.minutes : most.plays) ? h("p", { class: "st-note" }, `Most on ${dayOf(most.date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}: ${byTime ? minutesWords(most.minutes) : `${most.plays} watched`}.`) : null;

  // A usual week: weekday by half hour, darker where more is watched. Minutes when lengths are known, otherwise how many were logged then.
  const weekByTime = st.week.some((row) => row.some((v) => v > 0));
  const cells = weekByTime ? st.week : st.weekPlays;
  const timedWeek = cells.some((row) => row.some((v) => v > 0));
  // The part of the day most is watched in, said in words above the grid.
  const busiest = DAY_PARTS.reduce((a, b) => (st.parts[b] > st.parts[a] ? b : a), DAY_PARTS[0]);
  const partLine = st.parts[busiest] ? h("p", { class: "st-note" }, `Mostly ${busiest === "night" ? "at night" : `in the ${busiest}`}: ${st.parts[busiest]} of ${DAY_PARTS.reduce((n, p) => n + st.parts[p], 0)} watched.`) : null;
  const when = timedWeek
    ? heatmap({
        label: `A usual week, ${short(st.from)} to today: ${weekByTime ? "minutes watched" : "how many were watched"} by weekday and half hour`,
        rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        cells,
        max: Math.max(...cells.flat()),
        format: (v) => (!v ? "Nothing" : weekByTime ? `${v < 1 ? "Under 1" : Math.round(v)} min of the half hour, on average` : `${v} watched`),
      })
    : h("p", { class: "st-note" }, "Nothing watched here has a time of day.");

  const pct = (n: number) => `${n}%`;
  const tiles = [
    tile("Daily average", minutesWords(st.average), moved(st.average, st.before.average, minutesWords)),
    tile("Total", minutesWords(st.total), moved(st.total, st.before.total, minutesWords)),
    tile("Waking hours", pct(st.waking), moved(st.waking, st.before.waking, pct)),
    tile("Films", minutesWords(st.films), moved(st.films, st.before.films, minutesWords)),
    tile("Shows", minutesWords(st.shows), moved(st.shows, st.before.shows, minutesWords)),
    ...(st.videos || st.before.videos ? [tile("Videos", minutesWords(st.videos), moved(st.videos, st.before.videos, minutesWords))] : []),
  ];
  const partial = st.plays > st.timed ? h("p", { class: "st-note st-note--foot" }, `Time covers ${st.timed} of ${st.plays} watched. The rest have no length yet.`) : null;

  return [
    h("section", { class: "st-card" }, h("h3", { class: "st-card__title" }, "Each day"), chart, peak),
    h("section", { class: "st-card" }, h("h3", { class: "st-card__title" }, "A usual week"), partLine, when),
    h("dl", { class: "st-tiles", "aria-label": `Against the ${days} days before` }, ...tiles),
    h("p", { class: "st-note st-note--foot" }, `Changes are against the ${days} days before.`),
    ...(partial ? [partial] : []),
  ];
}

export function openScreenTime(items: StatItem[]): void {
  let days: number = SPANS[0].days;
  let asked = 0;
  const range = h("p", { class: "st-range" });
  const content = h("div", { class: "st-body" });
  const pick = (span: (typeof SPANS)[number]) => {
    const b = h("button", { class: "chip", type: "button", "aria-pressed": String(span.days === days) }, span.label);
    b.addEventListener("click", () => {
      days = span.days;
      void load();
    });
    return b;
  };
  const spans = h("div", { class: "chip-row st-spans", role: "group", "aria-label": "Over" });
  const root = h("div", { class: "st" }, h("div", { class: "st-head" }, range, spans), content);

  async function load() {
    const mine = ++asked;
    spans.replaceChildren(...SPANS.map(pick));
    content.classList.add("is-loading");
    try {
      const st = await loadScreenTime(days, items);
      if (mine !== asked) return;
      range.textContent = `${short(st.from)} to today`;
      content.replaceChildren(...(st.plays || st.before.plays ? body(st, days) : [h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Nothing watched in this stretch"), h("p", { class: "empty__sub" }, "Films, episodes and videos show here once Days has them."))]));
    } catch (error) {
      if (mine !== asked) return;
      content.replaceChildren(h("p", { class: "st-note" }, error instanceof Error ? error.message : "Couldn't load screen time."));
    } finally {
      if (mine === asked) content.classList.remove("is-loading");
    }
  }

  openSheet({ label: "Screen time", title: "Screen time", body: root, variant: "tall" });
  void load();
}
