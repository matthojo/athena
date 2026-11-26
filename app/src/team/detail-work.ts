/**
 * An assistant's work, first on its page (team-detail.ts): what it's doing
 * now, then what it has done, newest first under one heading per day
 * ("Today", "Yesterday", "Friday", "3 Nov", as the Team page). Each run says
 * what it did and what set it off, and opens the conversation it kept. A run
 * that didn't finish says why and offers Try again. With no runs yet, it says
 * when the assistant first starts.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import type { TeamAssistant, TeamRun } from "../db/team";
import { renderAvatarTile } from "./avatar";
import { firstStart, isLive, liveWords, pronouns, runLabel } from "./detail-words";
import { byDay, clock, deskFor, type WaitsOf } from "./page-words";
import { reviewWords, splitReport, waitsWords } from "../lib/team-report";

/** A time and its am/pm stay on one line: "5:00\u00a0pm". */
const keep = (s: string) => s.replace(/(\d) (am|pm)\b/g, "$1\u00a0$2");

/** Runs shown before "Show older". */
const FIRST = 6;

export interface WorkOptions {
  /** Open the conversation a run kept. */
  open: (r: TeamRun) => void;
  /** Ask it to start now (a failed run's Try again). */
  start: () => void;
  /** What each run still holds for Go (team/page-pulse.ts waitsFrom): the count the Team page and Home show. */
  waitsOf: () => WaitsOf;
}

export interface WorkHandle {
  el: HTMLElement;
  paint: (a: TeamAssistant, runs: TeamRun[]) => void;
}

export function workSection(opts: WorkOptions): WorkHandle {
  const title = h("h2", { class: "tdw__title", id: "tdw-title" });
  const body = h("div", { class: "tdw__body" });
  const el = h("section", { class: "tdw", "aria-labelledby": "tdw-title" }, h("header", { class: "tdw__head" }, title), body);
  let all = false;
  /** Runs seen working on an earlier paint: one that's finished since gets a moment of attention. */
  const wasLive = new Set<string>();
  const seen = new Set<string>();
  let first = true;

  function nowCard(a: TeamAssistant, r: TeamRun): HTMLElement {
    const cls = `tdw-now${!first && !seen.has(r.id) ? " is-new" : ""}`;
    const inner = [
      renderAvatarTile(a.avatar, { size: 44, mood: "thinking", animate: false }),
      h("span", { class: "tdw-now__text" }, h("span", { class: "tdw-now__step" }, `${liveWords(r)}…`), h("span", { class: "tdw-now__meta" }, keep(`${runLabel(r, a.triggers)} · started ${clock(r.started_at)}`))),
      h("span", { class: "team-dot tdw-now__pulse", "aria-hidden": "true" }),
    ];
    if (!r.thread_id) return h("div", { class: cls, role: "status" }, ...inner);
    const b = h("button", { class: `${cls} tdw-now--open`, type: "button", "aria-label": `${a.name}: ${liveWords(r)}. Open the conversation` }, ...inner);
    b.addEventListener("click", () => opts.open(r));
    return b;
  }

  function runCard(a: TeamAssistant, r: TeamRun, waits = 0): HTMLElement {
    const fresh = wasLive.has(r.id) && !isLive(r);
    const added = !first && !seen.has(r.id);
    const cls = `tdw-run is-${r.status}${fresh ? " is-fresh" : ""}${added ? " is-new" : ""}`;
    const meta = h("span", { class: "tdw-run__meta" }, h("span", { class: "tdw-run__why" }, keep(runLabel(r, a.triggers))), h("span", { class: "tdw-run__time" }, keep(clock(r.finished_at ?? r.started_at))));
    if (r.status === "failed") {
      const again = h("button", { class: "btn btn--soft btn--sm tdw-run__again", type: "button" }, icons.refresh(), "Try again");
      again.addEventListener("click", opts.start);
      const open = r.thread_id ? h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "See what happened") : null;
      open?.addEventListener("click", () => opts.open(r));
      return h(
        "li",
        { class: cls },
        h("span", { class: "tdw-run__mark", "aria-hidden": "true" }, icons.flag()),
        h("span", { class: "tdw-run__main" }, meta, h("span", { class: "tdw-run__what" }, "Didn't finish"), r.error ? h("span", { class: "tdw-run__error" }, r.error) : null, h("span", { class: "tdw-run__acts" }, again, open))
      );
    }
    // Its last run's plan, while it waits: the same count and words as the Team page and Home.
    const said = r.summary?.trim() || "Done";
    const what = h("span", { class: "tdw-run__what" }, waits ? splitReport(said).said || said : said);
    const count = waits ? h("span", { class: "tdw-run__waits" }, h("span", { class: "tdw-run__pip", "aria-hidden": "true" }), waitsWords(waits)) : null;
    // A run of one of its flows with no conversation (no thinking step): its run page shows each step.
    if (!r.thread_id && r.flow_run_id) {
      const link = h("a", { class: "tdw-run__open", href: `#/flows/runs/${encodeURIComponent(r.flow_run_id)}` }, h("span", { class: "tdw-run__mark", "aria-hidden": "true" }, icons.check()), h("span", { class: "tdw-run__main" }, meta, what, count), h("span", { class: "tdw-run__go", "aria-hidden": "true" }, icons.chevronRight()));
      return h("li", { class: `${cls}${waits ? " is-waiting" : ""}` }, link);
    }
    if (!r.thread_id) return h("li", { class: `${cls}${waits ? " is-waiting" : ""}` }, h("span", { class: "tdw-run__mark", "aria-hidden": "true" }, icons.check()), h("span", { class: "tdw-run__main" }, meta, what, count));
    const b = h("button", { class: "tdw-run__open", type: "button", ...(waits ? { "aria-label": `${runLabel(r, a.triggers)}: ${what.textContent} ${waitsWords(waits)}. ${reviewWords(waits)}` } : {}) }, h("span", { class: "tdw-run__mark", "aria-hidden": "true" }, icons.check()), h("span", { class: "tdw-run__main" }, meta, what, count), h("span", { class: "tdw-run__go", "aria-hidden": "true" }, icons.chevronRight()));
    b.addEventListener("click", () => opts.open(r));
    return h("li", { class: `${cls}${waits ? " is-waiting" : ""}` }, b);
  }

  function empty(a: TeamAssistant): HTMLElement {
    return h(
      "div",
      { class: "tdw-empty" },
      h("p", { class: "tdw-empty__title" }, "Nothing yet"),
      h("p", { class: "tdw-empty__text" }, a.paused ? `${a.name} is paused. Nothing starts until you turn ${pronouns(a.personality).them} back on.` : `${firstStart(a.name, a.triggers)} What ${a.name} does will show here.`)
    );
  }

  let last = "";
  function paint(a: TeamAssistant, runs: TeamRun[]) {
    // What waits is the last run's plan, as the Team page's desk reads it.
    const desk = deskFor(a, runs, new Date(), opts.waitsOf());
    const waitsFor = (r: TeamRun) => (r.id === desk.last?.id ? desk.waits : 0);
    // A look that found nothing new leaves the list alone, so the live card's pulse doesn't restart.
    const sig = JSON.stringify([a.name, a.paused, a.triggers.length, all, wasLive.size, desk.waits, runs.map((r) => [r.id, r.status, r.step, r.summary, r.thread_id])]);
    if (sig === last) return;
    last = sig;
    title.textContent = `What ${a.name} has done`;
    const live = runs.filter(isLive);
    const past = runs.filter((r) => !isLive(r));
    const parts: Node[] = [];
    if (live.length) parts.push(h("div", { class: "tdw-nows" }, ...live.map((r) => nowCard(a, r))));
    if (!past.length && !live.length) parts.push(empty(a));
    const shown = all ? past : past.slice(0, FIRST);
    // One heading per day, as the Team page's Recent runs; each run then says only its time.
    for (const [day, rs] of byDay(shown)) {
      parts.push(h("div", { class: "tdw-day" }, h("h3", { class: "tdw-day__title" }, day), h("ul", { class: "tdw-runs" }, ...rs.map((r) => runCard(a, r, waitsFor(r))))));
    }
    if (past.length > shown.length) {
      const more = h("button", { class: "btn btn--ghost btn--sm tdw-more", type: "button" }, `Show older (${past.length - shown.length})`);
      more.addEventListener("click", () => {
        all = true;
        paint(a, runs);
        body.querySelector<HTMLElement>(".tdw-day:last-of-type .tdw-run__open")?.focus({ preventScroll: true });
      });
      parts.push(more);
    }
    body.replaceChildren(...parts);
    wasLive.clear();
    for (const r of live) wasLive.add(r.id);
    for (const r of runs) seen.add(r.id);
    first = false;
  }

  return { el, paint };
}
