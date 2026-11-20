/**
 * One run, step by step (mockup 7): what set it off, then each step as it
 * ran, with a change that waits for your Go (Go or Skip), an Ask me's
 * choices, and when a Wait carries on. Earlier runs of the same flow below.
 * The page looks again every few seconds while the run is moving.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { answerRun, getFlow, getRun, goRun, onFlowsChange, skipRun, stopRun, type Flow, type FlowRun } from "../db/flows";
import { getAssistant, type TeamAssistant } from "../db/team";
import type { FlowRunStep, FlowStep } from "../../../lib/flow-types";
import { face, flowIcon, triggerTile } from "./parts";
import { findStep } from "./tree";
import { resumeWords, runHeading, runStateWords, stepTitle, triggerTitle } from "./words";

export interface RunPageContext {
  runId: string;
  /** Back to the flow (or the list when the flow is gone). */
  toFlow: (flowId: string | null) => void;
  openRun: (runId: string) => void;
}

const LOOK_EVERY = 3000;

export function renderRunPage(ctx: RunPageContext): { el: HTMLElement; destroy: () => void } {
  const back = h("button", { class: "flow-back", type: "button" }, icons.back(), h("span", {}, "Flow"));
  const body = h("div", { class: "flow-run", "aria-busy": "true" });
  const el = h("div", { class: "view flows flows--run" }, h("div", { class: "flow-top" }, back), body);
  let alive = true;
  let timer = 0;
  let run: FlowRun;
  let flow: Flow | null = null;
  let others: FlowRun[] = [];
  let assistant: TeamAssistant | null = null;
  let busy = false;
  back.addEventListener("click", () => ctx.toFlow(flow?.id ?? null));

  async function act(fn: () => Promise<FlowRun>, done?: string) {
    if (busy) return;
    busy = true;
    try {
      run = await fn();
      if (done) showToast(done);
    } catch (e) {
      showToast(e instanceof Error && e.message ? `Couldn't do that: ${e.message}` : "Couldn't do that. Try again.");
    } finally {
      busy = false;
      if (alive) paint();
      look();
    }
  }

  function stepOf(id: string): FlowStep | null {
    return flow ? (findStep(flow.steps, id)?.step ?? null) : null;
  }

  function line(s: FlowRunStep): HTMLElement {
    const step = stepOf(s.step_id);
    const title = step ? stepTitle(step, [], assistant?.name) : "A step that's since changed";
    const lead = step?.kind === "think" && assistant ? face(assistant.avatar, 28) : null;
    const parts: Node[] = [h("span", { class: "flow-trace__title" }, title)];
    if (s.status === "waiting" && s.pending) {
      const go = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Go");
      const skip = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Skip");
      go.addEventListener("click", () => void act(() => goRun(run.id, s.step_id), "Done. It's in Ask's list, with Undo."));
      skip.addEventListener("click", () => void act(() => skipRun(run.id, s.step_id), "Skipped. The flow carries on."));
      parts.push(h("div", { class: "flow-pending" }, h("span", { class: "flow-pending__mark", "aria-hidden": "true" }, flowIcon("todo")), h("span", { class: "flow-pending__text" }, s.pending.text)), h("div", { class: "flow-pending__acts" }, go, skip));
    } else if (s.status === "waiting" && s.question) {
      parts.push(h("span", { class: "flow-trace__q" }, s.question.text));
      const choices = h("div", { class: "flow-answer", role: "group", "aria-label": s.question.text });
      s.question.choices.forEach((c, i) => {
        const b = h("button", { class: "btn btn--soft btn--sm", type: "button" }, c);
        b.addEventListener("click", () => void act(() => answerRun(run.id, s.step_id, i), `You chose “${c}”`));
        choices.append(b);
      });
      parts.push(choices);
    } else if (s.status === "waiting" && s.resumes_at) {
      parts.push(h("span", { class: "flow-trace__line" }, `Carries on ${resumeWords(s.resumes_at)}`));
    } else parts.push(h("span", { class: "flow-trace__line" }, s.line));
    return h(
      "li",
      { class: `flow-trace__step flow-trace__step--${s.status}` },
      h("span", { class: "flow-trace__rail", "aria-hidden": "true" }, h("span", { class: `flow-mark flow-mark--${s.status}` })),
      h("span", { class: "flow-trace__body" }, lead ? h("span", { class: "flow-trace__who" }, lead, parts[0]) : parts[0], ...parts.slice(1)),
      h("span", { class: "visually-hidden" }, ` ${s.status === "done" ? "Done" : s.status === "waiting" ? "Waiting" : s.status === "skipped" ? "Skipped" : "Didn't work"}`)
    );
  }

  function paint() {
    const moving = run.status === "queued" || run.status === "running" || run.status === "waiting";
    const stop = moving ? h("button", { class: "btn btn--ghost btn--sm", type: "button" }, icons.stop(), "Stop this run") : null;
    stop?.addEventListener("click", () => void act(() => stopRun(run.id), "Stopped"));
    const state = runStateWords(run);
    const trig = flow ? h("li", { class: "flow-trace__step flow-trace__step--done" }, h("span", { class: "flow-trace__rail", "aria-hidden": "true" }, h("span", { class: "flow-mark flow-mark--done" })), h("span", { class: "flow-trace__body" }, h("span", { class: "flow-trace__title" }, triggerTitle(flow.trigger)), h("span", { class: "flow-trace__line" }, run.label))) : null;
    back.lastElementChild!.textContent = flow?.name ?? "Flows";
    body.replaceChildren(
      h(
        "div",
        { class: "flow-run__head" },
        flow ? (assistant ? face(assistant.avatar, 44) : triggerTile(flow.trigger)) : "",
        h("div", {}, h("h1", { class: "page-title" }, runHeading(run.started_at)), h("p", { class: "flow-run__label" }, `Set off by ${run.label.charAt(0).toLowerCase()}${run.label.slice(1)}`))
      ),
      h("span", { class: `flow-badge flow-badge--${run.status === "waiting" && (run.waits_for === "go" || run.waits_for === "answer") ? "you" : run.status === "failed" ? "bad" : "quiet"}` }, h("span", { class: "flow-badge__dot", "aria-hidden": "true" }), state),
      run.summary ? h("p", { class: "flow-run__summary" }, run.summary) : "",
      run.error ? h("p", { class: "flow-run__error" }, run.error) : "",
      h("ol", { class: "card flow-trace", "aria-label": "Steps" }, trig ?? "", ...run.steps.map(line)),
      stop ?? "",
      earlier()
    );
  }

  function earlier(): HTMLElement | string {
    const rest = others.filter((r) => r.id !== run.id).slice(0, 6);
    if (!rest.length) return "";
    return h(
      "section",
      { class: "flow-sec" },
      h("h2", { class: "flow-sec__title" }, "Earlier runs"),
      h(
        "div",
        { class: "card card--flush list" },
        ...rest.map((r) => {
          const b = h("button", { class: "row flow-run-row", type: "button" }, h("span", { class: `flow-mark flow-mark--${r.status}`, "aria-hidden": "true" }), h("span", { class: "row__body" }, h("span", { class: "row__title" }, r.summary ?? r.label), h("span", { class: "row__meta" }, `${runHeading(r.started_at)}${r.dry ? " · a try, nothing changed" : ""}`)), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
          b.addEventListener("click", () => ctx.openRun(r.id));
          return b;
        })
      )
    );
  }

  function look() {
    window.clearTimeout(timer);
    if (!alive || !run || !(run.status === "queued" || run.status === "running")) return;
    timer = window.setTimeout(async () => {
      const next = await getRun(ctx.runId).catch(() => null);
      if (!alive) return;
      if (next && !busy) {
        run = next;
        paint();
      }
      look();
    }, LOOK_EVERY);
  }

  async function load() {
    try {
      const found = await getRun(ctx.runId);
      if (!alive) return;
      body.removeAttribute("aria-busy");
      if (!found) return void body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "That run isn't here any more"), h("p", { class: "empty__sub" }, `A flow keeps its last runs only.`)));
      run = found;
      const f = await getFlow(run.flow_id).catch(() => null);
      flow = f?.flow ?? null;
      others = f?.runs ?? [];
      const who = run.assistant_id ?? flow?.assistant_id ?? null;
      assistant = who ? await getAssistant(who).catch(() => null) : null;
      if (!alive) return;
      paint();
      look();
    } catch {
      if (alive) body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "This run didn't load"), h("p", { class: "empty__sub" }, "Check you're online and try again.")));
    }
  }

  const off = onFlowsChange(() => {
    if (!run || busy) return;
    void getRun(ctx.runId).then((r) => {
      if (alive && r && !busy) {
        run = r;
        paint();
      }
    });
  });

  void load();
  return {
    el,
    destroy() {
      alive = false;
      off();
      window.clearTimeout(timer);
    },
  };
}
