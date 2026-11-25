/**
 * Health → Wellness (#/health/wellness): how the owner has felt, from the
 * morning and evening check-ins, over the same four weeks, six months or
 * year as Body. A card per scale question (Mood, Energy, Rest, Stress,
 * Productivity, the owner's own), each its average in the question's own
 * words, then the change since the range before, a bar a day, week or
 * month, and mornings against evenings; a card per word or area question
 * (Feelings, What affects how you feel, Main focus) with the ones picked
 * most; and the Mind card (mindful minutes, State of Mind), which moved
 * here from Body. Answers come from GET /api/checkins/trends
 * (db/checkins.ts loadCheckinTrends); the wording is
 * components/wellness-words.ts. Styles in styles/health.css.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { healthChart, type ChartPoint } from "../components/health-chart";
import { buckets, fmt, type RangeInfo } from "../components/health-range";
import { topPicks, answeredDays, cardOrder, checkedInLine, levelWord, mean, mornings, mornLine, oneplace, pickChange, questionTitle, rankPicks, scaleChange, scaleValues, type Ranked } from "../components/wellness-words";
import { listWords } from "../components/checkin-rules";
import { addDays } from "../../../lib/dates";
import { forOutcome, type Pattern } from "../../../lib/patterns";
import type { CheckinKind, CheckinQuestion, CheckinTrendDay, CheckinTrends } from "../../../lib/checkin-types";
import type { ViewId } from "../components/nav";

/** The Health page's card, as views/health.ts builds it. */
export type CardFn = (opts: { id: string; title: string; source: string | null; headline: HTMLElement | null; sub: string | null; chart: HTMLElement | null; extra?: HTMLElement | null; empty?: string; pattern?: (ps: Pattern[]) => Pattern | null | undefined }) => HTMLElement;

export interface WellnessInput {
  range: RangeInfo;
  start: string;
  end: string;
  trends: CheckinTrends;
  /** Whether a routine is on now; null when the set-up couldn't be read. */
  routinesOn: boolean | null;
  /** The Mind card from Body's figures, when there's anything for it. */
  mind: HTMLElement | null;
  card: CardFn;
  figure: (value: string, unit: string) => HTMLElement;
  go: (view: ViewId, opts?: { noteId?: string | null }) => void;
}

const SHOWN_PICKS = 6;
/** Answers needed before the range to say how it changed. */
const MIN_TO_COMPARE = 5;

/** "Mornings and evenings", from the check-ins that answered it. */
function askedWhen(days: CheckinTrendDay[]): string | null {
  const kinds = new Set<CheckinKind>(days.map((d) => d.kind));
  if (kinds.size === 2) return "Mornings and evenings";
  return kinds.has("morning") ? "Mornings" : kinds.has("evening") ? "Evenings" : null;
}

/** Each day's check-ins together, so a bar can average both. */
function byDay(days: CheckinTrendDay[]): Map<string, { date: string; all: CheckinTrendDay[] }> {
  const out = new Map<string, { date: string; all: CheckinTrendDay[] }>();
  for (const d of days) {
    const x = out.get(d.date) ?? { date: d.date, all: [] };
    x.all.push(d);
    out.set(d.date, x);
  }
  return out;
}

export function wellnessBody(o: WellnessInput): HTMLElement[] {
  const { range: r, start, end, trends } = o;
  const inRange = trends.days.filter((d) => d.date >= start && d.date <= end);
  const before = trends.days.filter((d) => d.date >= addDays(start, -r.days) && d.date < start);
  const bs = buckets(r.id, end, byDay(trends.days));
  const each = r.id === "4w" ? "each day" : `on average each ${r.id === "6m" ? "week" : "month"}`;

  if (!trends.days.length) return [firstTime(o), ...(o.mind ? [h("div", { class: "health__grid" }, o.mind)] : []), questionsRow(o)];

  // ---- how often, in one sentence ----
  const first = trends.days[0].date;
  const since = first > start ? first : start;
  const span = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${since}T12:00:00Z`)) / 86_400_000) + 1;
  const of = first > start ? `the ${span} ${span === 1 ? "day" : "days"} since ${fmt(first, { day: "numeric", month: "long" })}` : `these ${r.days} days`;
  const summary = h(
    "section",
    { class: "card health__latest wellness__summary", "aria-label": "Check-ins" },
    h("p", { class: "health__latest-day" }, "Check-ins"),
    h("p", { class: "health__latest-line" }, checkedInLine(inRange, of) ?? `No check-ins in ${r.in}.`)
  );

  const shown = cardOrder(trends.questions).filter((q) => [...inRange, ...before].some((d) => d.scales[q.id] !== undefined || d.picks[q.id]?.length));
  const cards = shown.map((q) => (q.type === "scale" ? scaleCard(q) : picksCard(q)));

  function scaleCard(q: CheckinQuestion): HTMLElement {
    const title = questionTitle(q);
    const now = mean(scaleValues(inRange, q.id));
    // A handful of answers before the range at least, or there's nothing fair to compare with.
    const earlier = scaleValues(before, q.id);
    const then = earlier.length >= MIN_TO_COMPARE ? mean(earlier) : null;
    const answered = inRange.filter((d) => d.scales[q.id] !== undefined);
    const points: ChartPoint[] = bs.map((b) => ({ label: b.label, tick: b.tick, value: mean(b.days.flatMap((d) => scaleValues(d.all, q.id))) }));
    const split = mornings(inRange, q.id);
    return o.card({
      id: `w-${q.id}`,
      title,
      source: askedWhen(answered),
      headline: now === null ? null : o.figure(levelWord(q, now), `${oneplace(now)} out of 5, on average`),
      sub: scaleChange(now, then, r.before),
      chart: now === null ? null : healthChart({ kind: "bars", points, label: `${title} ${each}`, format: (v) => `${levelWord(q, v)} · ${oneplace(v)}`, reference: () => ({ value: 5, text: levelWord(q, 5) }) }),
      extra: split ? splitBlock(q, split) : null,
      empty: `Not answered in ${r.in}`,
      // The Mind card shows the mindful pattern, so Mood shows another one.
      pattern: q.id === "mood" ? (ps) => forOutcome(ps, "mood").find((p) => !o.mind || p.factor_kind !== "mindful") : undefined,
    });
  }

  function picksCard(q: CheckinQuestion): HTMLElement {
    const ranked = rankPicks(inRange, q.id);
    const n = answeredDays(inRange, q.id);
    const noun = q.type === "areas" ? { one: "area", many: "areas" } : { one: "word", many: "words" };
    const top = topPicks(ranked, noun);
    const answered = inRange.filter((d) => d.picks[q.id]?.length);
    const most = ranked[0]?.days ?? 0;
    return o.card({
      id: `w-${q.id}`,
      title: questionTitle(q),
      source: askedWhen(answered),
      headline: top ? o.figure(top.value, `${top.tied > 2 ? "tied, " : ""}${top.tied > 1 ? "each " : ""}on ${most} of ${n} ${n === 1 ? "day" : "days"}`) : null,
      sub: pickChange(ranked, n, rankPicks(before, q.id), answeredDays(before, q.id), r.before),
      chart: null,
      extra: ranked.length ? rankList(ranked, q.type === "areas" ? "Areas picked most" : "Words picked most") : null,
      empty: `Not answered in ${r.in}`,
    });
  }

  return [summary, h("div", { class: "health__grid" }, ...cards, ...(o.mind ? [o.mind] : [])), questionsRow(o)];
}

/** Mornings against evenings on the question's own 1 to 5 line, with the sentence. */
function splitBlock(q: CheckinQuestion, split: { morning: number; evening: number }): HTMLElement {
  const row = (name: string, v: number) => [
    h("dt", { class: "wellness__split-name" }, name),
    h(
      "dd",
      { class: "wellness__split-row" },
      h("span", { class: "wellness__track", "aria-hidden": "true" }, h("span", { class: "wellness__dot", style: `--at: ${((v - 1) / 4) * 100}%` })),
      h("span", { class: "wellness__split-value" }, `${levelWord(q, v)} · ${oneplace(v)}`)
    ),
  ];
  return h("div", { class: "wellness__split" }, h("p", { class: "health__minor-note wellness__split-line" }, mornLine(split)), h("dl", { class: "wellness__split-list" }, ...row("Mornings", split.morning), ...row("Evenings", split.evening)));
}

/** The words or areas picked most, as bars against the most-picked, with the rest named underneath. */
function rankList(ranked: Ranked[], label: string): HTMLElement {
  const top = ranked.slice(0, SHOWN_PICKS);
  const rest = ranked.slice(SHOWN_PICKS).map((x) => x.word);
  const max = top[0].days;
  return h(
    "div",
    { class: "wellness__ranked" },
    h(
      "ul",
      { class: "wellness__rank", "aria-label": label },
      ...top.map((x) =>
        h(
          "li",
          { class: "wellness__rank-row" },
          h("span", { class: "wellness__rank-word" }, x.word),
          h("span", { class: "wellness__rank-bar", "aria-hidden": "true" }, h("span", { class: "wellness__rank-fill", style: `--share: ${(x.days / max) * 100}%` })),
          h("span", { class: "wellness__rank-days" }, `${x.days} ${x.days === 1 ? "day" : "days"}`)
        )
      )
    ),
    rest.length ? h("p", { class: "health__minor-note" }, `Also picked: ${rest.length > 6 ? `${rest.slice(0, 6).join(", ")} and ${rest.length - 6} more` : listWords(rest)}`) : null
  );
}

/** No check-ins at all yet: what this tab will show, and the way to start. */
function firstTime(o: WellnessInput): HTMLElement {
  const on = o.routinesOn === true;
  const set = h("button", { class: `btn ${on ? "btn--soft" : "btn--primary"} btn--sm`, type: "button" }, on ? "Choose questions" : "Set up check-ins");
  set.addEventListener("click", () => o.go("settings", { noteId: "checkins" }));
  const now = on ? h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Check in now") : null;
  now?.addEventListener("click", () => {
    void Promise.all([import("../components/checkin-flow"), import("../db/checkins")]).then(async ([flow, db]) => {
      const s = await db.loadCheckinSettings().catch(() => null);
      const morning = new Date().getHours() < 14;
      const kind: CheckinKind = s ? (morning && s.morning.enabled) || !s.evening.enabled ? "morning" : "evening" : morning ? "morning" : "evening";
      flow.openCheckinFlow(kind);
    });
  });
  return h(
    "div",
    { class: "card empty health__first" },
    h("span", { class: "tile" }, icons.chat()),
    h("p", { class: "empty__title" }, "No check-ins yet"),
    h("p", { class: "empty__sub" }, on ? "Once you've answered a check-in, how you've felt shows here, day by day." : "Turn on a morning or evening check-in, and how you've felt shows here, day by day."),
    h("div", { class: "health__first-actions" }, ...(now ? [now] : []), set)
  );
}

function questionsRow(o: WellnessInput): HTMLElement {
  const b = h("button", { class: "health__choose", type: "button" }, icons.sliders(), h("span", {}, "Choose your check-in questions"), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
  b.addEventListener("click", () => o.go("settings", { noteId: "checkins" }));
  return b;
}
