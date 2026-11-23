/**
 * Home's word from the team (docs/team.md, "Home"): one card under "For you"
 * that reads like colleagues reporting back. Whoever is on a job right now
 * comes first ("Wren is writing your week"), then each assistant's latest
 * report in its own words, with what waits on you one tap away ("Review 1
 * change"). One row per assistant, however many runs it did today ("3 jobs
 * today"), so a busy team never floods Home. The newest report is open; the
 * rest are a line each that opens in place.
 *
 * Reports are the server's team nudges (rule 'team', lib/team-run.ts). Who's
 * working comes from lib/team-live.ts (listActivity(), looked at again every
 * few seconds only while someone is).
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { renderAvatarTile } from "../team/avatar";
import { paintWho } from "../team/dot-colour";
import { onTeamChange, type TeamAssistant, type TeamRun } from "../db/team";
import { onTeamActivity } from "../lib/team-live";
import { getThread, onThreadsChange } from "../db/ask-threads";
import { dismissNudge, type AppNudge } from "../db/nudges";
import { isSampleMode } from "../db/api";
import { dismissSampleReport } from "../db/sample-team-reports";
import { openAskOnNudge } from "../lib/ask-nudge";
import { teamNudgeFrom, teamNudgeName } from "../lib/team-nudge";
import { jobsToday, jobsWords, liveRuns, ownWords, reviewWords, runWaits, saysNothing, splitReport, teamHomeLine, teamWorkingSentence, waitsWords, workingWords } from "../lib/team-report";
import { loadTeam } from "./ask-who";
import { causeWords, clock } from "../team/page-words";
import type { AvatarSpec } from "../../../lib/team-types";

/** The device's clock, as the Team page and the assistant's page write it ("22:10", "10:10 pm"). */
const timeOf = (iso: string) => clock(iso);
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Report {
  n: AppNudge;
  name: string;
  avatar: AvatarSpec | null;
  assistantId: string | null;
  said: string;
  /** Changes still waiting for Go. */
  waits: number;
  jobs: number;
}

/** The character in its tile (the kit's frame); `working` tilts it and breathes a ring round the tile. */
function face(avatar: AvatarSpec | null, size: number, working = false): HTMLElement {
  const el = avatar
    ? renderAvatarTile(avatar, { size, animate: false, mood: working ? "thinking" : "idle" })
    : h("span", { class: "kit-tile", style: `--kit-px:${size}px;--kit-tint:var(--sunken)`, "aria-hidden": "true" }, icons.team());
  el.classList.add("team-report__face");
  el.classList.toggle("is-working", working);
  return el;
}

/**
 * From the run's conversation, when it's on this device: its own words, and
 * the conversation itself, so a Go done since counts. Null without one.
 */
async function fromThread(n: AppNudge): Promise<{ said: string | null; messages: readonly unknown[] } | null> {
  if (!n.thread_id) return null;
  const t = await getThread(n.thread_id).catch(() => null);
  if (!t) return null;
  return { said: ownWords(t.messages), messages: t.messages };
}

/** The run a report is about: the server keys a run's card "team:<run id>" (lib/team-run.ts teamNudge). */
const runOf = (n: AppNudge, runs: readonly TeamRun[]): TeamRun | undefined => runs.find((r) => n.key === `team:${r.id}` || (!!n.thread_id && r.thread_id === n.thread_id));

export interface TeamReportView {
  el: HTMLElement;
  /** Draw these reports (the team's live nudges, newest first). Resolves to whether there's anything to show. */
  set: (reports: AppNudge[]) => Promise<boolean>;
  destroy: () => void;
}

/**
 * The team's card. `onShown` says whether it has anything (so For you can
 * hide when nothing at all is there), and fires again when that changes.
 *
 * `quiet` (Home) folds it to one line, "Moss is working. Wren reported
 * back.", which opens to the reports. It starts open only while a report
 * needs approval, and then that report is the one said in full.
 */
export function teamReport(opts: { onShown: (shown: boolean) => void; onGone: () => void; quiet?: boolean }): TeamReportView {
  const el = h("article", { class: `card team-report${opts.quiet ? " is-quiet" : ""}`, "aria-label": "From your team", hidden: true });
  /** Whether the quiet line is open: the owner's choice once made, else open only while something needs approval. */
  let unfolded: boolean | null = null;
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  let nudges: AppNudge[] = [];
  let runs: TeamRun[] = [];
  let team: TeamAssistant[] = [];
  /** Reports opened from a line; they stay open until Home is drawn again. */
  const opened = new Set<string>();
  let destroyed = false;
  let drawn = 0;
  /** Reports already drawn on this Home; null before the first draw. */
  let seen: Set<string> | null = null;

  async function reportsNow(): Promise<Report[]> {
    const out = await Promise.all(
      nudges.map(async (n): Promise<Report> => {
        const from = teamNudgeFrom(n as unknown as { rule: string } & Record<string, unknown>);
        const name = from?.name ?? teamNudgeName(n as unknown as { rule: string } & Record<string, unknown>) ?? "Your team";
        // The server's title is "From <Name>" and its summary the body; an older card has its own headline.
        const text = n.title === `From ${name}` ? n.body : [n.title, n.body].filter(Boolean).join(". ").replace(/\.\./g, ".");
        const { said, waits } = splitReport(text);
        const kept = await fromThread(n);
        // One count with the Team page and the sidebar (lib/team-report.ts runWaits): the run's own, its conversation here, else these words.
        const run = runOf(n, runs);
        const count = run ? runWaits(run, kept?.messages) : kept ? runWaits({ status: "done", started_at: n.created_at, summary: text }, kept.messages) : waits;
        return { n, name, avatar: from?.avatar ?? null, assistantId: from?.id ?? null, said: kept?.said || said || "It's ready in Ask.", waits: count, jobs: from?.id ? jobsToday(runs, from.id) : 0 };
      })
    );
    // A run that found nothing to do isn't a report (owner, 15 Nov 2026); an older server still makes a card for one.
    // What waits on you first, then the newest.
    return out.filter((r) => r.waits > 0 || !saysNothing(r.said)).sort((a, b) => Number(b.waits > 0) - Number(a.waits > 0) || Date.parse(b.n.created_at) - Date.parse(a.n.created_at));
  }

  function workingRow(run: TeamRun): HTMLElement | null {
    const a = team.find((x) => x.id === run.assistant_id);
    if (!a) return null;
    const words = workingWords(a.name, run);
    // What set it off: the server's own words when it sends them, else the trigger as the Team page says it, else a Run now.
    const what = causeWords(run, a) ?? (run.trigger_id ? null : "Run now");
    const go = h(
      "a",
      { class: "team-report__working", href: run.thread_id ? "#/ask" : `#/team/${encodeURIComponent(a.id)}` },
      face(a.avatar, 32, true),
      h("span", { class: "team-report__text" }, h("span", { class: "team-report__now" }, h("span", { class: "team-dot team-report__dot", "aria-hidden": "true" }), words), what ? h("span", { class: "team-report__what" }, what) : null)
    );
    // The dot and the ring round the face in the character's own colour (owner, 16 Nov 2026).
    paintWho(go, a.avatar);
    if (run.thread_id) {
      const thread = run.thread_id;
      go.addEventListener("click", (e) => {
        e.preventDefault();
        void import("../db/ask-threads").then(({ requestOpen }) => {
          requestOpen(thread);
          location.hash = "#/ask";
        });
      });
    }
    return go;
  }

  function dismiss(r: Report, node: HTMLElement) {
    if (isSampleMode()) dismissSampleReport(r.n.id);
    node.classList.add("is-leaving");
    void dismissNudge(r.n.id).catch(() => undefined);
    setTimeout(() => {
      nudges = nudges.filter((x) => x.id !== r.n.id);
      void paint();
      opts.onGone();
    }, reduced() ? 0 : 180);
  }

  /** The newest report, or one opened from its line: said in full, with what waits and Why. */
  function fullRow(r: Report): HTMLElement {
    const meta = [timeOf(r.n.created_at), jobsWords(r.jobs)].filter(Boolean).join(" · ");
    const open = h(
      "button",
      { class: "team-report__open", type: "button", "aria-label": `${r.name}, ${meta}: ${r.said}${r.waits ? ` ${waitsWords(r.waits)}.` : ""} ${r.n.thread_id ? "Open the conversation" : `Talk to ${r.name}`}` },
      face(r.avatar, 40),
      h(
        "span",
        { class: "team-report__text" },
        h("span", { class: "team-report__who" }, h("span", { class: "team-report__name" }, r.name), h("span", { class: "team-report__meta" }, meta)),
        h("span", { class: "team-report__said" }, r.said),
        r.waits ? h("span", { class: "team-report__waiting" }, h("span", { class: "team-report__pip", "aria-hidden": "true" }), waitsWords(r.waits)) : null
      )
    );
    open.addEventListener("click", () => openAskOnNudge(r.n));
    const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost team-report__close", type: "button", "aria-label": `Dismiss ${r.name}'s report` }, icons.close());
    const why = h("button", { class: "btn btn--ghost btn--sm team-report__why", type: "button" }, "Why am I seeing this?");
    why.addEventListener("click", () => void import("./nudge-card").then(({ openWhy }) => openWhy(r.n, { onMuted: opts.onGone })));
    const act = r.waits
      ? h("button", { class: "btn btn--primary btn--sm team-report__waits", type: "button", "data-waits": String(r.waits) }, reviewWords(r.waits), icons.arrowRight())
      : h("button", { class: "btn btn--soft btn--sm team-report__go", type: "button" }, r.n.thread_id ? "Open it" : `Reply to ${r.name}`, icons.arrowRight());
    act.addEventListener("click", () => openAskOnNudge(r.n));
    const row = h(
      "div",
      { class: "team-report__row is-full", "data-id": r.n.id },
      open,
      close,
      h("div", { class: "team-report__foot" }, act, why)
    );
    close.addEventListener("click", () => dismiss(r, row));
    return row;
  }

  /** Any other report: one line, which opens in place. */
  function lineRow(r: Report): HTMLElement {
    const open = h(
      "button",
      { class: "team-report__line", type: "button", "aria-expanded": "false", "aria-label": `${r.name}: ${r.said}${r.waits ? ` ${waitsWords(r.waits)}.` : ""} Show more` },
      face(r.avatar, 32),
      h("span", { class: "team-report__text" }, h("span", { class: "team-report__who" }, h("span", { class: "team-report__name" }, r.name), h("span", { class: "team-report__meta" }, timeOf(r.n.created_at))), h("span", { class: "team-report__said is-clipped" }, r.said)),
      r.waits ? h("span", { class: "team-report__badge", "aria-hidden": "true" }, String(r.waits)) : null,
      h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronDown())
    );
    open.addEventListener("click", () => {
      opened.add(r.n.id);
      void paint().then(() => el.querySelector<HTMLElement>(`.team-report__row[data-id="${CSS.escape(r.n.id)}"] .team-report__open`)?.focus());
    });
    const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost team-report__close", type: "button", "aria-label": `Dismiss ${r.name}'s report` }, icons.close());
    const row = h("div", { class: "team-report__row", "data-id": r.n.id }, open, close);
    close.addEventListener("click", () => dismiss(r, row));
    return row;
  }

  async function paint(): Promise<boolean> {
    const n = ++drawn;
    const reports = await reportsNow();
    if (destroyed || n !== drawn) return !el.hidden;
    const working = liveRuns(runs).map(workingRow).filter((x): x is HTMLElement => !!x);
    const needs = reports.some((r) => r.waits > 0);
    // Quiet: only a report that needs approval is said in full; the rest are a line each.
    const rows = reports.map((r, i) => ((opts.quiet ? r.waits > 0 && i === 0 : i === 0) || opened.has(r.n.id) ? fullRow(r) : lineRow(r)));
    // A report that arrived while Home was open settles in, so you see it come back from the job; the first draw stays still.
    if (seen) rows.forEach((row, i) => !seen!.has(reports[i].n.id) && row.classList.add("is-new"));
    seen = new Set([...(seen ?? []), ...reports.map((r) => r.n.id)]);
    const body = [...(working.length ? [h("div", { class: "team-report__now-list" }, ...working)] : []), ...rows];
    if (opts.quiet) {
      const open = unfolded ?? needs;
      const names = liveRuns(runs).map((r) => team.find((a) => a.id === r.assistant_id)?.name).filter((x): x is string => !!x);
      const line = teamHomeLine(names, reports.filter((r) => r.waits > 0).map((r) => r.name), reports.map((r) => r.name));
      const faces = [...new Map(reports.map((r) => [r.name, r.avatar] as const)).values()].slice(0, 3);
      const summary = h(
        "button",
        { class: "team-report__summary", type: "button", "aria-expanded": String(open), "aria-controls": "team-report-body" },
        faces.length ? h("span", { class: "team-report__faces", "aria-hidden": "true" }, ...faces.map((a) => face(a, 28))) : null,
        h("span", { class: "team-report__line-text" }, line || "Your team"),
        h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronDown())
      );
      summary.addEventListener("click", () => {
        unfolded = !open;
        void paint().then(() => el.querySelector<HTMLElement>(".team-report__summary")?.focus());
      });
      el.replaceChildren(summary, h("div", { class: "team-report__body", id: "team-report-body", hidden: !open }, ...body), live);
    } else el.replaceChildren(...body, live);
    const sentence = teamWorkingSentence(liveRuns(runs).map((r) => team.find((a) => a.id === r.assistant_id)?.name).filter((x): x is string => !!x));
    if ((live.textContent || null) !== sentence) live.textContent = sentence ?? "";
    const shown = working.length + rows.length > 0;
    if (el.hidden === shown) {
      el.hidden = !shown;
      opts.onShown(shown);
    }
    return shown;
  }

  /** Who's working (lib/team-live.ts looks again while anyone is), then draw. */
  const onRuns = (r: TeamRun[]) =>
    void loadTeam().then(async (t) => {
      if (destroyed) return;
      const was = liveRuns(runs).length;
      team = t;
      runs = r;
      await paint();
      // Someone just finished: their report may be on its way.
      if (liveRuns(runs).length < was) opts.onGone();
    });
  const offRuns = onTeamActivity(onRuns);
  const offTeam = onTeamChange(() => void loadTeam().then((t) => ((team = t), void paint())));
  // A Go in Ask changes what waits.
  const offThreads = onThreadsChange(() => void paint());

  return {
    el,
    async set(reports) {
      nudges = reports;
      return paint();
    },
    destroy() {
      destroyed = true;
      offRuns();
      offTeam();
      offThreads();
    },
  };
}
