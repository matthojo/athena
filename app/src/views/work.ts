/**
 * Work (#/work), in the Library beside Goals: what the owner closed, merged
 * and reviewed, from the work sync (GET /api/life/work, lib/work-data.ts;
 * the rules are lib/work-stats.ts). Only the owner's own work is ever here.
 *
 * One period at a time (This month, This quarter, This year, earlier
 * years), kept per device. In order: the headline (issues closed and pull
 * requests merged, each against the span before) with one line of words; a
 * year of days shipped; issues closed by project as ranked bars, each opening
 * that project's sheet; how long things take (start to close, open to
 * merge) as two small spreads; Work activity's notes on what shipped, what
 * was decided and what's stuck, open blockers first; and Code, only when a
 * code host is connected.
 *
 * Charts follow charts.css's mark spec (house-charts' barChart and its
 * helpers, a tooltip, a hidden table); the headline and cards are House's
 * (house.css). Nothing new is sent anywhere.
 */

import "../styles/life.css";
import "../styles/house.css";
import "../styles/work.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { pageHead } from "../components/page-head";
import { barChart, el, hiddenTable, sized } from "../components/house-charts";
import { openSheet } from "../components/sheet";
import { openAsk } from "../lib/open-ask";
import { loadWork, loadWorkProject, type WorkData, type WorkNote, type WorkProject, type WorkProjectDetail, type WorkSpread } from "../db/work";
import type { ViewId } from "../components/nav";

const PERIOD_KEY = "athena.work.period";
const read = () => {
  try {
    return localStorage.getItem(PERIOD_KEY);
  } catch {
    return null;
  }
};
const keep = (v: string) => {
  try {
    localStorage.setItem(PERIOD_KEY, v);
  } catch {
    // Private mode: kept until the page reloads.
  }
};

const num = (n: number) => n.toLocaleString("en-GB");
const count = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;
const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const dayMonth = (d: string, year = false) => noon(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const weekdayDay = (d: string) => noon(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const monthShort = (d: string) => noon(d).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "3 days", "under a day", "about 2 weeks". */
function daysWords(d: number): string {
  if (d < 1) return "under a day";
  if (d < 14) return count(Math.round(d), "day", "days");
  return `about ${count(Math.round(d / 7), "week", "weeks")}`;
}

/** "40 minutes", "4 hours", "2 days". */
function hoursWords(hrs: number): string {
  if (hrs < 1) return `${Math.max(1, Math.round(hrs * 60))} minutes`;
  if (hrs < 36) return count(Math.round(hrs), "hour", "hours");
  return daysWords(hrs / 24);
}

const ico = (make: () => SVGSVGElement, cls = "wk-ico") => {
  const s = make();
  s.classList.add(...cls.split(" "));
  s.setAttribute("aria-hidden", "true");
  return s;
};

// ---------- The headline ----------

function eyebrow(w: WorkData): string {
  const p = w.period;
  if (p.kind === "month") return `${MONTHS[Number(w.today.slice(5, 7)) - 1]} so far`;
  if (p.kind === "quarter") return "This quarter so far";
  if (p.kind === "year") return `${w.today.slice(0, 4)} so far`;
  return `In ${p.label}`;
}

/** "↑ 18% on October": more or fewer, neither good nor bad. */
function changeChip(now: number, before: number | undefined, label: string): HTMLElement | null {
  if (before === undefined) return null;
  if (!before) return now ? h("span", { class: "wk-chip", title: `None in ${label}` }, h("span", { "aria-hidden": "true" }, `None in ${label}`), h("span", { class: "visually-hidden" }, `None in ${label}`)) : null;
  const change = (now - before) / before;
  const pct = Math.round(Math.abs(change) * 100);
  const same = pct < 3;
  const words = same ? `About the same as ${label}` : `${pct}% ${change > 0 ? "more" : "fewer"} than ${label}`;
  return h("span", { class: `wk-chip${same ? " is-same" : ""}`, title: words }, h("span", { "aria-hidden": "true" }, same ? "≈" : change > 0 ? "↑" : "↓"), h("span", { "aria-hidden": "true" }, same ? label : `${pct}% on ${label}`), h("span", { class: "visually-hidden" }, words));
}

function figure(n: number, unit: string, chip: HTMLElement | null): HTMLElement {
  return h("div", { class: "wk-figure" }, h("p", { class: "tc-headline__row" }, h("span", { class: "tc-headline__big" }, num(n)), h("span", { class: "tc-headline__unit" }, unit)), chip);
}

function heroLine(w: WorkData): string {
  const shipped = w.count.issues_closed + w.count.prs_merged;
  if (!shipped) return w.period.kind === "past" ? `Nothing shipped in ${w.period.label}.` : "Nothing shipped in this stretch yet.";
  const top = w.projects.find((p) => p.name !== "No project");
  const named = w.projects.filter((p) => p.name !== "No project").length;
  const parts = [`On ${count(w.days, "day", "days")}${named > 1 && top ? `, across ${num(named)} projects, ${top.name} most of all` : top ? `, all in ${top.name}` : ""}.`];
  if (w.cycle) parts.push(`Issues usually took ${daysWords(w.cycle.median)} from start to close.`);
  return parts.join(" ");
}

function hero(w: WorkData): HTMLElement {
  const prev = w.previous;
  return h(
    "section",
    { class: "wk-hero", "aria-label": "What you shipped" },
    h("p", { class: "tc-headline__eyebrow" }, eyebrow(w)),
    h(
      "div",
      { class: "wk-figures" },
      figure(w.count.issues_closed, w.count.issues_closed === 1 ? "issue closed" : "issues closed", prev ? changeChip(w.count.issues_closed, prev.issues_closed, prev.label) : null),
      w.sources.github ? figure(w.count.prs_merged, w.count.prs_merged === 1 ? "pull request merged" : "pull requests merged", prev ? changeChip(w.count.prs_merged, prev.prs_merged, prev.label) : null) : null
    ),
    h("p", { class: "wk-hero__line" }, heroLine(w))
  );
}

// ---------- A year of days shipped ----------

const STEPS = 5;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A calendar of days, a column a week, Monday at the top: the darker, the more shipped that day. */
function yearMap(heat: WorkData["heat"]): HTMLElement {
  const days = heat.days;
  const weeks = Math.ceil(days.length / 7);
  const root = document.createElement("div");
  root.className = "hc wk-year viz-root";
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${heat.label}. Use the arrow keys to read each day.`);
  // The table by month: a row a day is too many to listen to.
  const months = new Map<string, number>();
  for (const d of days) if (!d.ahead) months.set(d.date.slice(0, 7), (months.get(d.date.slice(0, 7)) ?? 0) + d.count);
  const table = hiddenTable(heat.label, ["Month", "Shipped"], [...months].map(([m, n]) => [`${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`, count(n, "thing", "things")]));
  const tip = document.createElement("div");
  tip.className = "hc__tip";
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  const step = (v: number) => (!v || !heat.max ? 0 : Math.min(STEPS - 1, 1 + Math.floor(((v - 1) / Math.max(1, heat.max - 1)) * (STEPS - 1))));
  const words = (i: number) => {
    const d = days[i];
    return d.ahead ? weekdayDay(d.date) : `${weekdayDay(d.date)}: ${d.count ? count(d.count, "thing shipped", "things shipped") : "nothing shipped"}`;
  };
  let at = days.reduce((last, d, i) => (d.ahead ? last : i), 0);
  let showAt: (i: number) => void = () => undefined;

  const build = (W: number) => {
    const labelW = 26;
    const top = 16;
    // A phone stacks the year as two halves, so a day is big enough to see and touch.
    const bands = W < 560 ? 2 : 1;
    const perBand = Math.ceil(weeks / bands);
    const gap = W < 480 ? 2 : 2.5;
    const cell = Math.max(3, (W - labelW - gap * (perBand - 1)) / perBand);
    const bandH = top + 7 * cell + 6 * gap;
    const bandGap = 14;
    const H = bands * bandH + (bands - 1) * bandGap;
    const place = (i: number) => {
      const week = Math.floor(i / 7);
      const band = Math.floor(week / perBand);
      return { x: labelW + (week % perBand) * (cell + gap), y: band * (bandH + bandGap) + top + (i % 7) * (cell + gap), band };
    };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    const rects: SVGRectElement[] = [];
    for (let band = 0; band < bands; band++)
      [0, 2, 4].forEach((r) => {
        const t = el("text", { class: "hc__tick hc__tick--row", x: 0, y: band * (bandH + bandGap) + top + r * (cell + gap) + cell * 0.8 });
        t.textContent = WEEKDAYS[r];
        svg.append(t);
      });
    let lastMonth = "";
    days.forEach((d, i) => {
      const { x, y, band } = place(i);
      if (i % 7 === 0 && d.date.slice(0, 7) !== lastMonth && Number(d.date.slice(8)) <= 7) {
        lastMonth = d.date.slice(0, 7);
        const t = el("text", { class: "hc__tick", x, y: band * (bandH + bandGap) + 10 });
        t.textContent = monthShort(d.date);
        svg.append(t);
      }
      const r = el("rect", { class: d.ahead ? "wk-year__cell is-ahead" : `wk-year__cell hc__cell hc__cell--${step(d.count)}`, x, y, width: cell, height: cell, rx: Math.min(2, cell / 4) });
      rects.push(r);
      svg.append(r);
    });
    const hit = el("rect", { class: "hc__hit", x: labelW, y: 0, width: W - labelW, height: H });
    svg.append(hit);
    root.replaceChildren(svg, tip, table, live);
    showAt = (i) => {
      at = i;
      rects.forEach((x) => x.classList.remove("is-current"));
      rects[i].classList.add("is-current");
      tip.textContent = words(i);
      const { x, y } = place(i);
      const cx = x + cell / 2;
      const tw = tip.offsetWidth;
      tip.style.transform = `translate(${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px, ${y - tip.offsetHeight - 6}px)`;
      root.classList.add("is-hovering");
    };
    const pick = (e: PointerEvent) => {
      const b = svg.getBoundingClientRect();
      const px = ((e.clientX - b.left) / b.width) * W;
      const py = ((e.clientY - b.top) / b.height) * H;
      const band = Math.max(0, Math.min(bands - 1, Math.floor(py / (bandH + bandGap))));
      const col = Math.max(0, Math.min(perBand - 1, Math.floor((px - labelW) / (cell + gap))));
      const row = Math.max(0, Math.min(6, Math.floor((py - band * (bandH + bandGap) - top) / (cell + gap))));
      showAt(Math.min(days.length - 1, (band * perBand + col) * 7 + row));
    };
    hit.addEventListener("pointermove", pick);
    hit.addEventListener("pointerdown", pick);
    hit.addEventListener("pointerleave", () => document.activeElement !== root && root.classList.remove("is-hovering"));
  };
  root.addEventListener("focus", () => showAt(at));
  root.addEventListener("blur", () => root.classList.remove("is-hovering"));
  root.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(days.length - 1, at + d));
    showAt(i);
    live.textContent = words(i);
  });
  sized(root, build);
  const legend = h("div", { class: "hc-scale", "aria-hidden": "true" }, "Less", ...Array.from({ length: STEPS }, (_, i) => h("i", { class: `hc-scale__step hc__cell--${i}` })), "More");
  return h("div", { class: "hc-heat-wrap" }, root, legend);
}

function yearTake(heat: WorkData["heat"]): string {
  if (!heat.shipped_days) return "Nothing shipped in this stretch.";
  const by = [0, 0, 0, 0, 0, 0, 0];
  heat.days.forEach((d, i) => d.count && (by[i % 7] += 1));
  const best = by.indexOf(Math.max(...by));
  return `You shipped something on ${count(heat.shipped_days, "day", "days")}, ${["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][best]} most often.`;
}

function yearCard(w: WorkData): HTMLElement {
  return h("section", { class: "house-card wk-card wk-card--year", "aria-labelledby": "wk-year" }, h("h2", { class: "house-card__title", id: "wk-year" }, w.period.kind === "past" ? `Days you shipped in ${w.period.label}` : "Days you shipped"), h("p", { class: "house-card__take" }, yearTake(w.heat)), yearMap(w.heat));
}

// ---------- Projects ----------

function projectsCard(w: WorkData, open: (name: string) => void): HTMLElement | null {
  if (!w.projects.length) return null;
  const max = w.projects[0].issues_closed || 1;
  const row = (p: WorkProject, i: number) => {
    const b = h(
      "button",
      { class: "wk-rank", type: "button", "aria-label": `${i + 1}. ${p.name}, ${count(p.issues_closed, "issue closed", "issues closed")}${p.points ? `, ${count(p.points, "point", "points")}` : ""}` },
      h("span", { class: "wk-rank__n", "aria-hidden": "true" }, String(i + 1)),
      h(
        "span",
        { class: "wk-rank__body", "aria-hidden": "true" },
        h("span", { class: "wk-rank__top" }, h("span", { class: "wk-rank__name" }, p.name), h("span", { class: "wk-rank__count" }, num(p.issues_closed), p.points ? h("span", { class: "wk-rank__points" }, ` · ${count(p.points, "pt", "pts")}`) : null)),
        h("span", { class: "wk-rank__track" }, h("span", { class: "wk-rank__fill", style: `width:${Math.max(2, (p.issues_closed / max) * 100).toFixed(1)}%` }))
      ),
      ico(icons.chevronRight, "wk-ico wk-rank__go")
    );
    b.addEventListener("click", () => open(p.name));
    return h("li", {}, b);
  };
  return h("section", { class: "house-card wk-card wk-card--projects", "aria-labelledby": "wk-projects" }, h("h2", { class: "house-card__title", id: "wk-projects" }, "By project"), h("p", { class: "house-card__aside" }, "Issues closed"), h("ol", { class: "wk-ranks", role: "list" }, ...w.projects.slice(0, 8).map(row)));
}

// ---------- How long things take ----------

function spreadBlock(title: string, s: WorkSpread, median: string, noun: [string, string]): HTMLElement {
  const max = Math.max(...s.buckets.map((b) => b.count), 1);
  return h(
    "div",
    { class: "wk-spread" },
    h("h3", { class: "wk-spread__title" }, title),
    h("p", { class: "wk-spread__median" }, h("span", { class: "wk-spread__big" }, median), h("span", { class: "wk-spread__unit" }, ` median, over ${count(s.n, noun[0], noun[1])}`)),
    h(
      "ul",
      { class: "wk-bins", role: "list", "aria-label": `${title}, ${count(s.n, noun[0], noun[1])}` },
      ...s.buckets.map((b) =>
        h(
          "li",
          { class: "wk-bin" },
          h("span", { class: "wk-bin__label" }, b.label),
          h("span", { class: "wk-bin__track", "aria-hidden": "true" }, h("span", { class: "wk-bin__fill", style: `width:${b.count ? Math.max(3, (b.count / max) * 100).toFixed(1) : 0}%` })),
          h("span", { class: "wk-bin__n" }, num(b.count))
        )
      )
    )
  );
}

function timesCard(w: WorkData): HTMLElement | null {
  if (!w.cycle && !w.merge) return null;
  return h(
    "section",
    { class: "house-card wk-card wk-card--times", "aria-labelledby": "wk-times" },
    h("h2", { class: "house-card__title", id: "wk-times" }, "How long things take"),
    h("div", { class: "wk-spreads" }, w.cycle ? spreadBlock("Start to close", w.cycle, daysWords(w.cycle.median), ["issue", "issues"]) : null, w.merge ? spreadBlock("Open to merge", w.merge, hoursWords(w.merge.median), ["pull request", "pull requests"]) : null)
  );
}

// ---------- Shipped, decided, stuck ----------

const KIND_WORD: Record<WorkNote["kind"], string> = { shipped: "Shipped", decided: "Decided", stuck: "Stuck" };

function notesCard(w: WorkData): HTMLElement | null {
  if (!w.notes.length) return null;
  const open = w.notes.filter((n) => n.kind === "stuck" && n.open).length;
  return h(
    "section",
    { class: "house-card wk-card wk-card--notes", "aria-labelledby": "wk-notes" },
    h("h2", { class: "house-card__title", id: "wk-notes" }, "Shipped, decided, stuck"),
    open ? h("p", { class: "house-card__take" }, open === 1 ? "One blocker is still open." : `${num(open)} blockers are still open.`) : null,
    h(
      "ul",
      { class: "wk-notes", role: "list" },
      ...w.notes.slice(0, 8).map((n) =>
        h(
          "li",
          {},
          h(
            "a",
            { class: `wk-note${n.kind === "stuck" && n.open ? " is-open" : ""}`, href: `#/notes/${encodeURIComponent(n.id)}` },
            h("span", { class: `wk-tag wk-tag--${n.kind}` }, n.kind === "stuck" ? (n.open ? "Still stuck" : "Unblocked") : KIND_WORD[n.kind]),
            h("span", { class: "wk-note__title" }, n.title),
            h("span", { class: "wk-note__when" }, dayMonth(n.date)),
            ico(icons.chevronRight, "wk-ico wk-note__go")
          )
        )
      )
    )
  );
}

// ---------- Code ----------

function codeCard(w: WorkData): HTMLElement | null {
  const c = w.code;
  if (!c) return null;
  const stat = (n: number, label: string) => h("div", { class: "wk-stat" }, h("dt", {}, label), h("dd", {}, num(n)));
  const max = c.repos[0]?.merged || 1;
  return h(
    "section",
    { class: "house-card wk-card wk-card--code", "aria-labelledby": "wk-code" },
    h("h2", { class: "house-card__title", id: "wk-code" }, "Code"),
    h("dl", { class: "wk-stats" }, stat(c.opened, "Opened"), stat(c.merged, "Merged"), stat(c.reviewed, "Reviewed")),
    c.merged_for_others || c.open_now
      ? h("p", { class: "house-card__aside" }, [c.merged_for_others ? `You merged ${count(c.merged_for_others, "pull request", "pull requests")} for other people.` : "", c.open_now ? (c.open_now === 1 ? "One of yours is still open." : `${num(c.open_now)} of yours are still open.`) : ""].filter(Boolean).join(" "))
      : null,
    c.repos.length
      ? h(
          "ul",
          { class: "wk-bins wk-repos", role: "list", "aria-label": "Merged, by repository" },
          ...c.repos.map((r) => h("li", { class: "wk-bin" }, h("span", { class: "wk-bin__label wk-mono" }, r.repo), h("span", { class: "wk-bin__track", "aria-hidden": "true" }, h("span", { class: "wk-bin__fill", style: `width:${Math.max(3, (r.merged / max) * 100).toFixed(1)}%` })), h("span", { class: "wk-bin__n" }, num(r.merged))))
        )
      : null
  );
}

// ---------- The project sheet ----------

function projectBody(p: WorkProjectDetail): HTMLElement {
  const ask = h("button", { class: "btn btn--soft wk-sheet__ask", type: "button" }, icons.chat(), "Ask about this project");
  ask.addEventListener("click", () => openAsk({ prompt: `How's ${p.name} going? What did I close on it lately, and what's still open?` }));
  const chart = p.months.some((m) => m.count)
    ? barChart({
        label: `Issues closed each month on ${p.name}`,
        series: [{ name: "Issues closed", cls: "is-electric" }],
        points: p.months.map((m, i) => ({ label: `${MONTHS[Number(m.from.slice(5, 7)) - 1]} ${m.from.slice(0, 4)}`, tick: i % 3 === 0 || i === p.months.length - 1 ? monthShort(m.from) : undefined, values: [m.count], faint: i === p.months.length - 1 })),
        format: (v) => count(v, "issue", "issues"),
        height: 120,
      })
    : null;
  const open = p.issues.filter((i) => !i.closed);
  const done = p.issues.filter((i) => i.closed);
  const row = (i: WorkProjectDetail["issues"][number]) => {
    const inner = [h("span", { class: "wk-issue__id wk-mono" }, i.identifier ?? ""), h("span", { class: "wk-issue__title" }, i.title), h("span", { class: "wk-issue__when" }, i.closed ? dayMonth(i.closed) : (i.state ?? "Open"))];
    return h("li", {}, i.url ? h("a", { class: "wk-issue", href: i.url, target: "_blank", rel: "noopener noreferrer" }, ...inner) : h("div", { class: "wk-issue" }, ...inner));
  };
  return h(
    "div",
    { class: "wk-sheet" },
    h("p", { class: "wk-sheet__big" }, count(p.issues_closed, "issue closed", "issues closed"), p.points ? h("span", { class: "wk-sheet__meta" }, ` · ${count(p.points, "point", "points")}`) : null),
    h(
      "dl",
      { class: "wk-facts" },
      h("div", {}, h("dt", {}, "First closed"), h("dd", {}, p.first ? dayMonth(p.first, true) : "Not yet")),
      h("div", {}, h("dt", {}, "Last closed"), h("dd", {}, p.last ? dayMonth(p.last, true) : "Not yet")),
      p.cycle ? h("div", {}, h("dt", {}, "Start to close"), h("dd", {}, daysWords(p.cycle.median))) : null
    ),
    chart ? h("div", { class: "wk-sheet__chart" }, h("h3", { class: "wk-sheet__sub" }, "Closed each month"), chart) : null,
    open.length ? h("h3", { class: "wk-sheet__sub" }, "Still open") : null,
    open.length ? h("ul", { class: "wk-issues", role: "list" }, ...open.map(row)) : null,
    done.length ? h("h3", { class: "wk-sheet__sub" }, "Recently closed") : null,
    done.length ? h("ul", { class: "wk-issues", role: "list" }, ...done.slice(0, 10).map(row)) : null,
    h("div", { class: "wk-sheet__actions" }, ask, p.project_id ? h("a", { class: "btn btn--ghost", href: `#/projects/${encodeURIComponent(p.project_id)}` }, icons.project(), "Open the project") : null)
  );
}

function openProjectSheet(name: string): void {
  const body = h("div", { class: "wk-sheet", "aria-busy": "true" }, h("span", { class: "skeleton wk-sk wk-sk--sheet" }));
  openSheet({ label: name, title: name, body });
  loadWorkProject(name).then(
    (p) => {
      body.removeAttribute("aria-busy");
      body.replaceChildren(p ? projectBody(p) : h("p", { class: "life-empty__text" }, `None of your issues are in ${name} now.`));
    },
    () => {
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("p", { class: "life-empty__text" }, "This didn't load. Check you're online, then try again."));
    }
  );
}

// ---------- The page ----------

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "life-empty wk-empty" },
    h("span", { class: "wk-empty__icon" }, ico(icons.work, "wk-ico wk-ico--lg")),
    h("p", { class: "life-empty__title" }, "No work counted yet"),
    h("p", { class: "life-empty__text" }, "Connect your issue tracker or code host and turn on Your work, counted. Athena reads back a year of your own issues and pull requests."),
    h("a", { class: "btn btn--soft btn--sm", href: "#/settings/sources" }, icons.plug(), "Open Sources")
  );
}

function skeleton(): HTMLElement {
  return h("div", { class: "wk-skeleton", "aria-hidden": "true" }, h("span", { class: "skeleton wk-sk wk-sk--hero" }), h("span", { class: "skeleton wk-sk wk-sk--card" }), h("span", { class: "skeleton wk-sk wk-sk--card" }));
}

export function renderWork(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let dead = false;
  let period = read() ?? "month";
  let seq = 0;
  const switcher = h("div", { class: "segmented segmented--sub wk-periods", role: "radiogroup", "aria-label": "Period" });
  const body = h("div", { class: "wk-page", "aria-busy": "true" }, skeleton());
  const el = h("div", { class: "view lists work-view" }, pageHead({ segments: librarySegments("work", ctx.go), title: "Work" }), switcher, body);

  const paintSwitch = (w: WorkData) => {
    const choices = w.periods;
    switcher.hidden = !w.has_work;
    switcher.replaceChildren(
      ...choices.map((c, i) => {
        const on = c.id === w.period.id;
        const b = h("button", { class: "segmented__item", type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1" }, c.label) as HTMLButtonElement;
        b.addEventListener("click", () => choose(c.id));
        b.addEventListener("keydown", (ev) => {
          const to = ev.key === "ArrowRight" ? choices[(i + 1) % choices.length] : ev.key === "ArrowLeft" ? choices[(i + choices.length - 1) % choices.length] : null;
          if (!to) return;
          ev.preventDefault();
          choose(to.id, true);
        });
        return b;
      })
    );
  };

  const paint = (w: WorkData, animate: boolean) => {
    body.removeAttribute("aria-busy");
    paintSwitch(w);
    if (!w.has_work) {
      body.replaceChildren(emptyState());
      return;
    }
    const some = (xs: Array<HTMLElement | null>) => xs.filter((x): x is HTMLElement => !!x);
    // Two stacks on a wide screen (projects and times on the left, notes and code on the right); one column on a phone, in reading order.
    body.replaceChildren(
      h("div", { class: "wk-grid" }, hero(w), yearCard(w), h("div", { class: "wk-col" }, ...some([projectsCard(w, openProjectSheet), timesCard(w)])), h("div", { class: "wk-col" }, ...some([notesCard(w), codeCard(w)])))
    );
    if (animate) {
      body.classList.remove("is-entering");
      void body.offsetWidth;
      body.classList.add("is-entering");
    }
  };

  const load = (animate = false, focus = false) => {
    const mine = ++seq;
    body.setAttribute("aria-busy", "true");
    loadWork(period).then(
      (w) => {
        if (dead || mine !== seq) return;
        // A kept year with no work now falls back to this month on the server; keep what it answered.
        if (w.period.id !== period) {
          period = w.period.id;
          keep(period);
        }
        paint(w, animate);
        if (focus) switcher.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
      },
      () => {
        if (dead || mine !== seq) return;
        body.removeAttribute("aria-busy");
        body.replaceChildren(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "Work didn't load"), h("p", { class: "life-empty__text" }, "Check you're online, then come back to this page.")));
      }
    );
  };
  const choose = (id: string, focus = false) => {
    if (id === period) return;
    period = id;
    keep(id);
    load(true, focus);
  };
  load();
  return {
    el,
    destroy: () => {
      dead = true;
    },
  };
}
