/**
 * Health, in the Library beside Trips and Purchases: sleep, steps,
 * workouts and weight over four weeks, six months or a year, built from the
 * sealed day figures (GET /api/health/days, merged on the server by the
 * owner's choice of app per figure). Each figure is a sentence first, then
 * its chart: averages over the range, compared with the range before.
 * Nothing is cached on the device. "Log" (components/health-log-sheet.ts)
 * types a day in by hand, for anyone without a connected app.
 *
 * Two tabs: Body (#/health), the figures above, and Wellness
 * (#/health/wellness, views/health-wellness.ts), the morning and evening
 * check-ins over the same range, with the Mind card.
 */

import "../styles/health.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { healthChart, routeSketch, type ChartPoint } from "../components/health-chart";
import { openHealthLogSheet } from "../components/health-log-sheet";
import { loadHealthDays, loadHealthSources, SOURCE_NAMES, type HealthChoice, type HealthDay, type HealthDays, type HealthSources, type Workout } from "../db/health";
import { healthLine, hoursMinutes, kilos, litres, MG_PER_COFFEE, RECHARGE, stagesLine, workoutLine } from "../../../lib/health-line";
import "../styles/health-food.css";
import { hasStages, stageBar, stageLegend, STAGES, UNSTAGED } from "../components/sleep-stages";
import { addDays } from "../../../lib/dates";
import { buckets, fmt, longDay, RANGES, shortDay, type Bucket as RangeBucket, type Range } from "../components/health-range";
import { wellnessBody } from "./health-wellness";
import { loadCheckinSettings, loadCheckinTrends, onCheckinsChange, type CheckinTrends } from "../db/checkins";
import { localToday } from "../lib/time";
import { loadPatterns } from "../db/patterns";
import { patternSlot } from "../components/patterns-block";
import { forOutcome, type Pattern } from "../../../lib/patterns";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";
import { clockOfDay } from "../lib/clock";

const RANGE_KEY = "athena.healthRange";

const thousands = (n: number) => Math.round(n).toLocaleString("en-GB");
/** Workout time: "9h 24m", or "114 hours" once it's long. */
const timeIn = (m: number) => (m >= 600 ? `${Math.round(m / 60)} hours` : hoursMinutes(m));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

type Bucket = RangeBucket<HealthDay>;

type Tab = "body" | "wellness";
const TABS: Array<{ id: Tab; label: string; path: string | null }> = [
  { id: "body", label: "Body", path: null },
  { id: "wellness", label: "Wellness", path: "wellness" },
];

/**
 * The last figures read, kept in memory only (never on the device), so
 * moving between Body and Wellness paints at once while they're read again.
 */
let kept: { data: HealthDays; sources: HealthSources | null; trends: CheckinTrends | null; routinesOn: boolean | null } | null = null;

const workoutsOf = (days: HealthDay[]) => days.flatMap((d) => (d.workouts ?? []).map((w) => ({ ...w, date: d.date })));
const minutesOf = (days: HealthDay[]) => workoutsOf(days).reduce((n, w) => n + w.minutes, 0);

/** "22 min more than the 4 weeks before", or nothing when there's nothing to compare. */
function compare(now: number | null, then: number | null, opts: { what: (diff: number) => string; same: number; before: string; less?: string }): string | null {
  if (now === null || then === null) return null;
  const diff = now - then;
  if (Math.abs(diff) < opts.same) return `About the same as ${opts.before}`;
  return `${opts.what(Math.abs(diff))} ${diff > 0 ? "more" : opts.less ?? "fewer"} than ${opts.before}`;
}

/** Which app a figure came from, in words. */
function sourceWord(choice: HealthChoice, s: HealthSources | null): string | null {
  if (!s) return null;
  const can = s.can_send[choice].filter((x) => s.connected.includes(x));
  if (!can.length) return null;
  const pick = can.includes(s.prefs[choice]) ? s.prefs[choice] : can[0];
  if (choice === "workouts" && pick !== "strava" && s.connected.includes("strava")) return `${SOURCE_NAMES[pick]} and Strava`;
  return SOURCE_NAMES[pick];
}

export function renderHealth(ctx: { go: (view: ViewId, opts?: { noteId?: string | null }) => void; path?: string | null }): { el: HTMLElement; destroy: () => void } {
  const tab: Tab = ctx.path === "wellness" ? "wellness" : "body";
  let range: Range = "4w";
  try {
    const saved = sessionStorage.getItem(RANGE_KEY) as Range | null;
    if (saved && RANGES.some((r) => r.id === saved)) range = saved;
  } catch {
    // private mode: start at four weeks
  }
  let data: HealthDays | null = kept?.data ?? null;
  let sources: HealthSources | null = kept?.sources ?? null;
  let trends: CheckinTrends | null = kept?.trends ?? null;
  let routinesOn: boolean | null = kept?.routinesOn ?? null;
  let failed = false;
  let dead = false;

  const rangeRow = h("div", { class: "chip-row health__range", role: "radiogroup", "aria-label": "Show" });
  const paintRange = () =>
    rangeRow.replaceChildren(
      ...RANGES.map((r) => {
        const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(r.id === range) }, r.label);
        b.addEventListener("click", () => {
          if (r.id === range) return;
          range = r.id;
          try {
            sessionStorage.setItem(RANGE_KEY, range);
          } catch {
            // fine
          }
          paintRange();
          paint();
        });
        return b;
      })
    );
  paintRange();

  const body = h("div", { class: "health__body", "aria-busy": "true" });
  const LEDE = "Sleep, steps, workouts and weight from the apps you've connected and what you log yourself. Only you can see them.";
  const WELLNESS_LEDE = "How you've felt, from your morning and evening check-ins. Only you can see this.";
  const logBtn = tab === "body" ? h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Log") : null;
  logBtn?.addEventListener("click", () => openHealthLogSheet(() => load()));
  const lede = h("p", { class: "page-lede" }, tab === "body" ? LEDE : WELLNESS_LEDE);
  const tabs = h(
    "nav",
    { class: "segmented segmented--sub health__tabs", "aria-label": "Health" },
    ...TABS.map((t) => {
      const b = h("button", { class: "segmented__item", type: "button", "aria-current": t.id === tab ? "page" : undefined }, t.label);
      b.addEventListener("click", () => {
        if (t.id === tab) return;
        history.pushState(history.state, "", `#/health${t.path ? `/${t.path}` : ""}`);
        ctx.go("health", { noteId: t.path });
      });
      return b;
    })
  );
  const el = h(
    "div",
    { class: "view lists health" },
    pageHead({ segments: librarySegments("health", ctx.go), title: "Health", actions: [rangeRow, logBtn], lede, below: [tabs] }),
    body
  );

  function card(opts: { id: string; title: string; source: string | null; headline: HTMLElement | null; sub: string | null; chart: HTMLElement | null; extra?: HTMLElement | null; empty?: string; before?: HTMLElement | null; pattern?: (ps: Pattern[]) => Pattern | null | undefined }): HTMLElement {
    return h(
      "section",
      { class: `card health__card health__card--${opts.id}`, "aria-labelledby": `health-${opts.id}` },
      h("div", { class: "health__card-head" }, h("h2", { class: "health__card-title", id: `health-${opts.id}` }, opts.title), opts.source ? h("span", { class: "health__source" }, opts.source) : null),
      opts.headline ?? h("p", { class: "health__empty" }, opts.empty ?? "Nothing yet"),
      opts.sub ? h("p", { class: "health__sub" }, opts.sub) : null,
      opts.before ?? null,
      opts.chart,
      opts.extra ?? null,
      // One pattern about this figure, over the same stretch as the chart.
      opts.pattern && opts.headline ? patternSlot(loadPatterns(range === "4w" ? 30 : range === "6m" ? 90 : 365), opts.pattern) : null
    );
  }

  const figure = (value: string, unit: string) => h("p", { class: "health__figure" }, h("span", { class: "health__value" }, value), h("span", { class: "health__unit" }, unit));

  function workoutRow(w: Workout & { date: string }): HTMLElement {
    const sketch = w.route ? routeSketch(w.route) : null;
    const meta = [shortDay(w.date), clockOfDay(w.start), `${w.minutes} min`].filter(Boolean).join(" · ");
    return h(
      "li",
      { class: "health__workout" },
      h("span", { class: `health__route${sketch ? "" : " health__route--none"}` }, sketch ?? icons.flag()),
      h("span", { class: "health__workout-body" }, h("span", { class: "health__workout-title" }, workoutLine(w)), h("span", { class: "health__workout-meta" }, meta))
    );
  }

  function paint() {
    if (failed) {
      body.removeAttribute("aria-busy");
      const retry = h("button", { class: "btn btn--soft", type: "button" }, icons.refresh(), "Try again");
      retry.addEventListener("click", () => {
        failed = false;
        body.setAttribute("aria-busy", "true");
        retry.disabled = true;
        load();
      });
      body.replaceChildren(h("div", { class: "card empty" }, h("span", { class: "tile" }, icons.wifiOff()), h("p", { class: "empty__title" }, "Couldn't reach Athena"), h("p", { class: "empty__sub" }, tab === "body" ? "Your health figures stay on your server. Try again when you're online." : "Your check-ins stay on your server. Try again when you're online."), retry));
      return;
    }
    if (!data || (tab === "wellness" && !trends)) return;
    body.removeAttribute("aria-busy");
    const today = data.today || localToday();
    const byDate = new Map(data.days.map((d) => [d.date, d]));
    rangeRow.hidden = tab === "body" ? !data.days.length : !trends!.days.length;
    if (tab === "body" && !data.days.length) return void body.replaceChildren(emptyState());

    const r = RANGES.find((x) => x.id === range)!;
    // Body ends yesterday until today has figures; check-ins are answered as the day goes, so Wellness ends today.
    const end = tab === "wellness" || byDate.has(today) ? today : addDays(today, -1);
    const start = addDays(end, -(r.days - 1));
    const inRange = data.days.filter((d) => d.date >= start && d.date <= end);
    const before = data.days.filter((d) => d.date >= addDays(start, -r.days) && d.date < start);
    const bs = buckets(range, end, byDate);
    const avgPoints = (f: (d: HealthDay) => number | undefined): ChartPoint[] =>
      bs.map((b) => ({ label: b.label, tick: b.tick, value: mean(b.days.map(f).filter((v): v is number => v !== undefined)) }));

    if (tab === "wellness") {
      // Wellness: the check-ins, with the Mind card from the figures.
      const { mind } = foodAndMind(inRange, before, bs, r);
      body.replaceChildren(...wellnessBody({ range: r, start, end, trends: trends!, routinesOn, mind, card, figure, go: ctx.go }));
      return;
    }

    // ---- the last day, in the Life log's words ----
    const lastDay = [...data.days].reverse().find((d) => healthLine(d));
    const lastLine = lastDay ? healthLine(lastDay) : null;
    const latest = lastDay
      ? h(
          "section",
          { class: "card health__latest", "aria-label": "Latest day" },
          h("p", { class: "health__latest-day" }, lastDay.date === addDays(today, -1) ? `Yesterday · ${longDay(lastDay.date)}` : lastDay.date === today ? `Today · ${longDay(lastDay.date)}` : longDay(lastDay.date)),
          h("p", { class: "health__latest-line" }, ...lastLine!.split(" · ").flatMap((part, i) => [i ? h("span", { class: "health__dot", "aria-hidden": "true" }, " · ") : null, h("span", { class: "health__part" }, part)]))
        )
      : null;

    // ---- sleep ----
    const sleepNow = mean(inRange.map((d) => d.sleep_minutes).filter((v): v is number => v !== undefined));
    const sleepThen = mean(before.map((d) => d.sleep_minutes).filter((v): v is number => v !== undefined));
    // Stages: the latest night as one bar, and each bar of the chart split deep → REM → core.
    const staged = inRange.filter((d) => d.sleep_minutes !== undefined && hasStages(d.sleep_stages));
    const lastNight = [...inRange].reverse().find((d) => d.sleep_minutes !== undefined);
    const nightName = (date: string) => (date === today ? "Last night" : `${fmt(addDays(date, -1), { weekday: "long" })} night`);
    const night =
      lastNight && hasStages(lastNight.sleep_stages)
        ? h(
            "div",
            { class: "health__night" },
            h("p", { class: "health__night-label" }, `${nightName(lastNight.date)} · ${shortDay(lastNight.date)}`),
            h(
              "p",
              { class: "health__night-line" },
              ...[`${hoursMinutes(lastNight.sleep_minutes!)} sleep`, ...(stagesLine(lastNight.sleep_stages)?.split(" · ") ?? [])].flatMap((part, i) => [i ? h("span", { class: "health__dot", "aria-hidden": "true" }, " · ") : null, h("span", { class: "health__part" }, part)])
            ),
            stageBar(lastNight.sleep_stages, { label: `${nightName(lastNight.date)} by stage` })
          )
        : null;
    /** A bucket's average night split into deep, REM, core and no stage, adding up to its average sleep. */
    const stackOf = (days: HealthDay[]): { value: number | null; parts: number[] } => {
      const slept = days.filter((d) => d.sleep_minutes !== undefined);
      if (!slept.length) return { value: null, parts: [] };
      const total = mean(slept.map((d) => d.sleep_minutes!))!;
      const parts = STAGES.map((st) => slept.reduce((n, d) => n + (hasStages(d.sleep_stages) ? (d.sleep_stages[st.key] ?? 0) : 0), 0) / slept.length);
      return { value: total, parts: [...parts, Math.max(0, total - parts.reduce((a, b) => a + b, 0))] };
    };
    const useStack = staged.length > 0;
    const sleepPoints: ChartPoint[] = useStack ? bs.map((b) => ({ label: b.label, tick: b.tick, ...stackOf(b.days) })) : avgPoints((d) => d.sleep_minutes);
    const avgStage = (key: (typeof STAGES)[number]["key"]) => mean(staged.map((d) => d.sleep_stages![key] ?? 0))!;
    const anyUnstaged = useStack && sleepPoints.some((p) => (p.parts?.[3] ?? 0) >= 1);
    const stagesAvg = useStack
      ? h(
          "div",
          { class: "health__stages-avg" },
          stageLegend([...STAGES.map((st) => ({ stage: st, minutes: avgStage(st.key) })), ...(anyUnstaged ? [{ stage: UNSTAGED }] : [])]),
          h("p", { class: "health__minor-note" }, staged.length === inRange.filter((d) => d.sleep_minutes !== undefined).length ? "A night on average" : `A night on average, over the ${staged.length} ${staged.length === 1 ? "night" : "nights"} with stages`)
        )
      : null;
    const sleep = card({
      id: "sleep",
      title: "Sleep",
      source: sourceWord("sleep", sources),
      headline: sleepNow === null ? null : figure(hoursMinutes(sleepNow), "a night"),
      sub: compare(sleepNow, sleepThen, { what: (d) => `${Math.round(d)} min`, same: 5, before: r.before, less: "less" }),
      before: night,
      chart:
        sleepNow === null
          ? null
          : healthChart({
              kind: "bars",
              points: sleepPoints,
              label: range === "4w" ? "Sleep each night" : `Sleep, a night on average each ${range === "6m" ? "week" : "month"}`,
              format: hoursMinutes,
              reference: () => ({ value: 480, text: "8h" }),
              ...(useStack ? { stack: [...STAGES, UNSTAGED].map((st) => ({ name: st.name, cls: st.cls })) } : {}),
            }),
      extra: stagesAvg,
      empty: `No sleep in ${r.in}`,
      pattern: (ps) => forOutcome(ps, "sleep", "deep")[0],
    });

    // ---- steps ----
    const stepsNow = mean(inRange.map((d) => d.steps).filter((v): v is number => v !== undefined));
    const stepsThen = mean(before.map((d) => d.steps).filter((v): v is number => v !== undefined));
    const steps = card({
      id: "steps",
      title: "Steps",
      source: sourceWord("steps", sources),
      headline: stepsNow === null ? null : figure(thousands(stepsNow), "a day"),
      sub: compare(stepsNow, stepsThen, { what: (d) => thousands(d), same: Math.max(150, (stepsThen ?? 0) * 0.03), before: r.before }),
      chart: stepsNow === null ? null : healthChart({ kind: "bars", points: avgPoints((d) => d.steps), label: range === "4w" ? "Steps each day" : `Steps, a day on average each ${range === "6m" ? "week" : "month"}`, format: (v) => thousands(v), reference: () => ({ value: 10000, text: "10k" }) }),
      empty: `No steps in ${r.in}`,
      pattern: (ps) => forOutcome(ps, "steps")[0],
    });

    // ---- workouts ----
    const ws = workoutsOf(inRange);
    const wsBefore = workoutsOf(before);
    const total = minutesOf(inRange);
    const recent = ws.slice(-5).reverse();
    const wPoints: ChartPoint[] = bs.map((b) => ({ label: b.label, tick: b.tick, value: b.days.length || range !== "4w" ? minutesOf(b.days) || null : null }));
    const workouts = card({
      id: "workouts",
      title: "Workouts",
      source: sourceWord("workouts", sources),
      headline: ws.length ? figure(String(ws.length), `${ws.length === 1 ? "workout" : "workouts"} · ${timeIn(total)}`) : null,
      sub: ws.length ? compare(ws.length, before.length ? wsBefore.length : null, { what: (d) => String(Math.round(d)), same: 1, before: r.before }) : null,
      chart: ws.length ? healthChart({ kind: "bars", points: wPoints, label: `Workout time each ${range === "4w" ? "day" : range === "6m" ? "week" : "month"}`, format: (v) => hoursMinutes(v), reference: (max) => (max >= 60 ? { value: Math.floor(max / 60) * 60, text: `${Math.floor(max / 60)}h` } : { value: 30, text: "30m" }) }) : null,
      extra: recent.length ? h("div", { class: "health__recent" }, h("h3", { class: "health__minor" }, "Latest"), h("ul", { class: "health__workouts" }, ...recent.map(workoutRow))) : null,
      empty: `No workouts in ${r.in}`,
      // A pattern about workouts the Sleep card isn't already showing.
      pattern: (ps) => ps.find((x) => (x.factor_kind === "workout" || x.factor_kind === "any_workout" || x.factor_kind === "long_run") && x.id !== forOutcome(ps, "sleep", "deep")[0]?.id),
    });

    // ---- weight: only the days you weighed in ----
    const weighIns = inRange.filter((d) => d.weight_kg !== undefined);
    const lastW = weighIns[weighIns.length - 1];
    const firstW = weighIns[0];
    let weightSub: string | null = null;
    const since = (d: string) => fmt(d, { day: "numeric", month: "long", ...(d.slice(0, 4) !== end.slice(0, 4) ? { year: "numeric" } : {}) });
    if (lastW && firstW && firstW !== lastW) {
      const diff = Math.round((lastW.weight_kg! - firstW.weight_kg!) * 10) / 10;
      weightSub = Math.abs(diff) < 0.2 ? `About the same since ${since(firstW.date)}` : `${diff < 0 ? "Down" : "Up"} ${kilos(Math.abs(diff))} since ${since(firstW.date)}`;
    } else if (lastW) weightSub = `Weighed on ${longDay(lastW.date)}`;
    const dayPoints: ChartPoint[] = Array.from({ length: r.days }, (_, i) => {
      const d = addDays(start, i);
      const tick = range === "4w" ? ((r.days - 1 - i) % 7 === 0 ? fmt(d, { day: "numeric", month: "short" }) : undefined) : d.endsWith("-01") ? fmt(d, { month: "short" }) : undefined;
      return { label: longDay(d), value: byDate.get(d)?.weight_kg ?? null, tick };
    });
    const weight = card({
      id: "weight",
      title: "Weight",
      source: sourceWord("weight", sources),
      headline: lastW ? figure(kilos(lastW.weight_kg!).replace(" kg", ""), "kg") : null,
      sub: weightSub,
      chart: weighIns.length ? healthChart({ kind: "line", points: dayPoints, label: "Weight on each weigh-in", format: kilos }) : null,
      empty: `No weigh-ins in ${r.in}`,
    });

    // ---- recovery: Whoop's score or Polar's recharge, from whichever app leads sleep; never mixed on one scale ----
    const scored = inRange.filter((d) => d.recovery !== undefined).length;
    const rated = inRange.filter((d) => d.recharge !== undefined).length;
    const hasRecovery = data.days.some((d) => d.recovery !== undefined || d.recharge !== undefined) || !!sources?.connected.some((x) => x === "whoop" || x === "polar");
    let recovery: HTMLElement | null = null;
    if (hasRecovery) {
      const whoop = scored >= rated;
      const field = (d: HealthDay) => (whoop ? d.recovery : d.recharge);
      const now = mean(inRange.map(field).filter((v): v is number => v !== undefined));
      const then = mean(before.map(field).filter((v): v is number => v !== undefined));
      const other = whoop ? rated : scored;
      const left = other ? `${other} ${other === 1 ? "night" : "nights"} from ${whoop ? "Polar" : "Whoop"} not shown: it rates nights on its own scale.` : null;
      const word = (v: number) => RECHARGE[Math.min(6, Math.max(1, Math.round(v))) - 1];
      let sub: string | null = null;
      if (now !== null && then !== null) {
        const diff = now - then;
        if (whoop) sub = Math.abs(diff) < 3 ? `About the same as ${r.before}` : `${Math.round(Math.abs(diff))} points ${diff > 0 ? "higher" : "lower"} than ${r.before}`;
        else sub = Math.abs(diff) < 0.5 ? `About the same as ${r.before}` : `${diff > 0 ? "Better" : "Worse"} than ${r.before}`;
      }
      const each = range === "4w" ? "each night" : `on average each ${range === "6m" ? "week" : "month"}`;
      recovery = card({
        id: "recovery",
        title: "Recovery",
        source: now === null ? null : whoop ? "Whoop" : "Polar",
        headline: now === null ? null : whoop ? figure(`${Math.round(now)}%`, "on average") : figure(word(now), "recharge, on average"),
        sub: [sub, left].filter(Boolean).join(". ") || null,
        chart:
          now === null
            ? null
            : whoop
              ? healthChart({ kind: "bars", points: avgPoints((d) => d.recovery), label: `Whoop recovery ${each}`, format: (v) => `${Math.round(v)}%`, reference: () => ({ value: 67, text: "67%" }) })
              : healthChart({ kind: "bars", points: avgPoints((d) => d.recharge), label: `Polar Nightly Recharge ${each}`, format: (v) => `${word(v)} recharge`, reference: () => ({ value: 4, text: "OK" }) }),
        empty: `No recovery in ${r.in}. It comes from Whoop or Polar, whichever leads sleep.`,
        pattern: (ps) => forOutcome(ps, "resting_hr")[0],
      });
    }
    // ---- food and drink (Apple Health, or Oura's tags); Mind is on Wellness ----
    const { food } = foodAndMind(inRange, before, bs, r);

    lede.textContent = recovery ? "Sleep, recovery, steps, workouts and weight from the apps you've connected. Only you can see them." : LEDE;

    const choose = h("button", { class: "health__choose", type: "button" }, icons.sliders(), h("span", {}, "Choose where each figure comes from"), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
    choose.addEventListener("click", () => ctx.go("settings", { noteId: "health" }));

    body.replaceChildren(...[latest, h("div", { class: "health__grid" }, sleep, recovery, steps, workouts, weight, food), choose].filter((x): x is HTMLElement => !!x));
  }

  /**
   * The Food and drink card (calories a day, with coffee, water and drinks
   * in words) and the Mind card (mindful minutes, and State of Mind's
   * moods). Each only once something has come in, so a Shortcut without
   * the fold adds no empty cards.
   */
  function foodAndMind(inRange: HealthDay[], before: HealthDay[], bs: Bucket[], r: (typeof RANGES)[number]): { food: HTMLElement | null; mind: HTMLElement | null } {
    const vals = (days: HealthDay[], f: (d: HealthDay) => number | undefined) => days.map(f).filter((v): v is number => v !== undefined);
    const avg = (days: HealthDay[], f: (d: HealthDay) => number | undefined) => mean(vals(days, f));
    const points = (f: (d: HealthDay) => number | undefined): ChartPoint[] => bs.map((b) => ({ label: b.label, tick: b.tick, value: mean(vals(b.days, f)) }));
    const each = range === "4w" ? "each day" : `a day on average each ${range === "6m" ? "week" : "month"}`;
    const anyFood = (d: HealthDay) => d.kcal !== undefined || d.caffeine_mg !== undefined || d.water_ml !== undefined || d.alcohol_drinks !== undefined;
    const fed = inRange.filter(anyFood);
    let food: HTMLElement | null = null;
    if (fed.length || before.some(anyFood)) {
      const kcal = avg(inRange, (d) => d.kcal);
      const coffee = avg(fed, (d) => d.caffeine_mg ?? 0);
      const water = avg(inRange, (d) => d.water_ml);
      const drinks = fed.reduce((n, d) => n + (d.alcohol_drinks ?? 0), 0);
      const lastCups = vals(fed, (d) => (d.caffeine_last ? Number(d.caffeine_last.slice(0, 2)) * 60 + Number(d.caffeine_last.slice(3)) : undefined));
      const lateDays = fed.filter((d) => (d.caffeine_after_14_mg ?? 0) > 0).length;
      const usualLast = lastCups.length ? lastCups.sort((a, b) => a - b)[Math.floor(lastCups.length / 2)] : null;
      const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
      const weeks = Math.max(1, fed.length / 7);
      const cups = coffee === null ? null : Math.round((coffee / MG_PER_COFFEE) * 10) / 10;
      const facts: Array<[string, string]> = [
        ...(cups ? ([["Coffee", `${cups} ${cups === 1 ? "cup" : "cups"} a day${usualLast !== null ? `, the last usually by ${clockOfDay(clock(usualLast))}` : ""}`]] as Array<[string, string]>) : []),
        ...(lateDays ? ([[`After ${clockOfDay("14:00")}`, `${lateDays} of ${fed.length} days`]] as Array<[string, string]>) : []),
        ...(water !== null ? ([["Water", `${litres(water)} a day`]] as Array<[string, string]>) : []),
        ...(fed.length ? ([["Alcohol", drinks ? `${Math.round((drinks / weeks) * 10) / 10} drinks a week` : "None"]] as Array<[string, string]>) : []),
      ];
      food = card({
        id: "food",
        title: "Food and drink",
        source: sourceWord("nutrition", sources),
        headline: kcal === null ? (cups ? figure(String(cups), "coffees a day") : null) : figure(thousands(kcal), "kcal a day"),
        sub: kcal === null ? null : compare(kcal, avg(before, (d) => d.kcal), { what: (d) => `${thousands(d)} kcal`, same: 50, before: r.before }),
        chart: kcal === null ? null : healthChart({ kind: "bars", points: points((d) => d.kcal), label: `Calories ${each}`, format: (v) => `${thousands(v)} kcal`, reference: (max) => { const v = Math.ceil((max * 1.05) / 500) * 500; return { value: v, text: thousands(v) }; } }),
        extra: facts.length ? h("dl", { class: "hfood__facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])) : null,
        empty: `No food or drink in ${r.in}`,
        pattern: (ps) => ps.find((x) => ["caffeine_late", "drinks", "late_meal", "water"].includes(x.factor_kind)),
      });
    }
    const anyMind = (d: HealthDay) => d.mindful_minutes !== undefined || d.mood_valence !== undefined;
    let mind: HTMLElement | null = null;
    if (inRange.some(anyMind) || before.some(anyMind)) {
      const total = inRange.reduce((n, d) => n + (d.mindful_minutes ?? 0), 0);
      const days = inRange.filter((d) => (d.mindful_minutes ?? 0) > 0).length;
      const totalBefore = before.reduce((n, d) => n + (d.mindful_minutes ?? 0), 0);
      const moods = vals(inRange, (d) => d.mood_valence);
      const labels = new Map<string, number>();
      for (const d of inRange) for (const l of d.mood_labels ?? []) labels.set(l, (labels.get(l) ?? 0) + 1);
      const top = [...labels].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l.toLowerCase());
      const pleasant = moods.filter((v) => v > 0.05).length;
      const often = top.length ? `. Often ${top.length > 1 ? `${top.slice(0, -1).join(", ")} or ${top[top.length - 1]}` : top[0]}` : "";
      const moodLine = moods.length ? `${pleasant >= moods.length / 2 ? `Pleasant on ${pleasant}` : `Unpleasant on ${moods.length - pleasant}`} of the ${moods.length} ${moods.length === 1 ? "day" : "days"} you logged one${often}.` : null;
      mind = card({
        id: "mind",
        title: "Mind",
        source: sourceWord("mind", sources),
        headline: total ? figure(hoursMinutes(total).replace(/^(\d+)m$/, "$1 min"), `mindful · ${days} ${days === 1 ? "day" : "days"}`) : null,
        sub: total ? compare(total, before.length ? totalBefore : null, { what: (d) => (d >= 60 ? hoursMinutes(d) : `${Math.round(d)} min`), same: 10, before: r.before, less: "less" }) : null,
        chart: total ? healthChart({ kind: "bars", points: points((d) => d.mindful_minutes ?? (anyMind(d) ? 0 : undefined)), label: `Mindful minutes ${each}`, format: (v) => `${Math.round(v)} min`, reference: () => ({ value: 10, text: "10 min" }) }) : null,
        extra: moodLine ? h("p", { class: "hfood__mood" }, h("span", { class: "hfood__mood-label" }, "State of Mind"), moodLine) : null,
        empty: moodLine ? `No mindful minutes in ${r.in}` : `Nothing in ${r.in}`,
        pattern: (ps) => ps.find((x) => x.factor_kind === "mindful") ?? forOutcome(ps, "mood")[0],
      });
    }
    return { food, mind };
  }

  function emptyState(): HTMLElement {
    const log = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.plus(), "Log by hand");
    log.addEventListener("click", () => openHealthLogSheet(() => load(), { date: localToday() }));
    const phone = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Set up Apple Health");
    phone.addEventListener("click", () => ctx.go("settings", { noteId: "iphone" }));
    const apps = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Connect an app");
    apps.addEventListener("click", () => ctx.go("settings", { noteId: "sources" }));
    return h(
      "div",
      { class: "card empty health__first" },
      h("span", { class: "tile" }, icons.heart()),
      h("p", { class: "empty__title" }, "Nothing here yet"),
      h("p", { class: "empty__sub" }, "Log your sleep, steps, weight and workouts yourself, send Apple Health from your iPhone, or connect Oura, Withings or Strava."),
      h("div", { class: "health__first-actions" }, log, phone, apps)
    );
  }

  const load = () => {
    const today = localToday();
    // Wellness also reads the check-ins over the same two years, and whether a routine is on (for its first-time card).
    const wellness =
      tab === "wellness"
        ? Promise.all([loadCheckinTrends(addDays(today, -730), today), loadCheckinSettings().then((x) => x.morning.enabled || x.evening.enabled, () => null)])
        : Promise.resolve(null);
    void Promise.all([loadHealthDays(addDays(today, -730), today), loadHealthSources().catch(() => null), wellness])
      .then(([d, s, w]) => {
        data = d;
        sources = s;
        if (w) [trends, routinesOn] = w;
        kept = { data, sources, trends, routinesOn };
      })
      .catch(() => {
        // Figures already on screen stay; with nothing to show, say so.
        if (!data || (tab === "wellness" && !trends)) failed = true;
      })
      .finally(() => !dead && paint());
  };
  // A check-in answered here, on another device or through MCP shows up while Wellness is open.
  const off = tab === "wellness" ? onCheckinsChange(() => load()) : () => undefined;
  if (data && (tab === "body" || trends)) paint();
  load();

  return {
    el,
    destroy: () => {
      dead = true;
      off();
    },
  };
}
