/**
 * One flow, as a story you read down the page (mockups 4 and 9): When (the
 * trigger, with what it gives you), Then (each step, with + between them),
 * branch lanes under a Check or an Ask me, nested up to FLOW_LIMITS.depth,
 * and Done. The On switch at the top, and "Try it on the last one" at the
 * bottom (a dry run: nothing is changed).
 *
 * A flow an assistant runs shows its face, on the page and on each thinking
 * step, with Take it back; a plain flow offers to hand it to one.
 *
 * Every change saves at once (PATCH /api/flows/:id), as Team's page does.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { deleteFlow, getFlow, loadCatalog, onFlowsChange, previewValues, runFlow, takeBack, updateFlow, type Flow, type FlowRun } from "../db/flows";
import { getAssistant, listTeam, type TeamAssistant } from "../db/team";
import { FLOW_LIMITS, type CatalogEntry, type FlowStep, type FlowValue, type ValueRef } from "../../../lib/flow-types";
import { badge, face, flowIcon, givesRow, stepTile, switchInput, textWithChips, triggerTile, type Lookup } from "./parts";
import { brokenSteps, branchesOf, canBranchAt, countSteps, findStep, hasRoom, insertStep, newStepId, removeStep, replaceStep, valuesBefore, valuesForStep, walk, type Branch, type ListPath } from "./tree";
import { BRANCH_WORDS, conditionWords, flowKindWords, runHeading, stepTitle, triggerTitle, tryWords, waitsForGo } from "./words";
import { changes, entryFor, stepFromEntry } from "./steps";
import { openAddStep } from "./add-step";
import { openStepSheet } from "./step-sheet";
import { openTriggerSheet } from "./trigger-sheet";
import { openHandSheet } from "./hand-sheet";
import { refKey } from "./text";
import { triggerWords } from "./words";

export interface EditorContext {
  id: string;
  back: () => void;
  openRun: (runId: string) => void;
}

/** Things Athena couldn't place when it drew the flow, shown once on the editor it opens. */
const pendingNotes = new Map<string, string[]>();
export function setDraftNotes(flowId: string, notes: string[]): void {
  if (notes.length) pendingNotes.set(flowId, notes);
}

/** A closed sheet steps back in history a beat later: wait for it before moving on. */
const afterSheet = () => new Promise<void>((r) => window.setTimeout(r, 450));

/** "today", "yesterday", "on 3 Nov": when a flow was handed over. */
function handedWords(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const w = runHeading(iso, false, now).replace(/ at .*$/, "");
  return w === "Today" || w === "Yesterday" ? w.toLowerCase() : `on ${w}`;
}

export function renderFlowEditor(ctx: EditorContext): { el: HTMLElement; destroy: () => void } {
  const back = h("button", { class: "flow-back", type: "button" }, icons.back(), h("span", {}, "Flows"));
  back.addEventListener("click", ctx.back);
  const more = h("button", { class: "icon-btn icon-btn--ghost flow-more", type: "button", "aria-label": "More" }, icons.more());
  const body = h("div", { class: "flow-ed", "aria-busy": "true" });
  const foot = h("div", { class: "flow-foot", hidden: true });
  const el = h("div", { class: "view flows flows--editor" }, h("div", { class: "flow-top" }, back, more), body, foot);

  let alive = true;
  let flow: Flow;
  let runs: FlowRun[] = [];
  let catalog: CatalogEntry[] = [];
  let assistant: TeamAssistant | null = null;
  let team: TeamAssistant[] = [];
  const notes = pendingNotes.get(ctx.id) ?? [];
  pendingNotes.delete(ctx.id);

  // ---------- saving ----------
  async function save(patch: Parameters<typeof updateFlow>[1], undo?: () => void): Promise<boolean> {
    try {
      flow = await updateFlow(flow.id, patch);
      if (alive) paint();
      return true;
    } catch (e) {
      undo?.();
      if (alive) paint();
      showToast(e instanceof Error && e.message ? `Couldn't save that: ${e.message}` : "Couldn't save that. Try again.");
      return false;
    }
  }
  const saveSteps = (steps: FlowStep[], extra: Parameters<typeof updateFlow>[1] = {}) => {
    const was = flow.steps;
    flow = { ...flow, steps };
    paint();
    return save({ steps, ...extra }, () => (flow = { ...flow, steps: was }));
  };

  // ---------- values ----------
  /** Every value in the flow, by "from.key". */
  function allValues() {
    const out = new Map<string, FlowValue & { ref: ValueRef; fromStep: string | null }>();
    for (const v of flow.trigger_gives) out.set(`trigger.${v.key}`, { ...v, ref: { from: "trigger", key: v.key }, fromStep: null });
    walk(flow.steps, (s) => {
      if (s.kind === "tool" || s.kind === "think") for (const v of s.gives) out.set(`${s.id}.${v.key}`, { ...v, ref: { from: s.id, key: v.key }, fromStep: s.id });
    });
    return out;
  }
  /** Labels for a step's chips: known only when the step can reach the value. */
  function lookFor(step: FlowStep | null): Lookup {
    const all = allValues();
    const reach = new Set((step ? valuesForStep(flow, step.id) : []).map((v) => refKey(v.ref)));
    return (r) => {
      const v = all.get(refKey(r));
      return { label: v?.label ?? "a value that's gone", kind: v?.kind ?? "text", known: !!v && (!step || reach.has(refKey(r))) };
    };
  }

  // ---------- adding and changing steps ----------
  function whereWords(path: ListPath, index: number): string {
    const list = path.length ? (findStep(flow.steps, path[path.length - 1].step)?.step ?? null) : null;
    const siblings = (() => {
      let l: FlowStep[] = flow.steps;
      for (const seg of path) {
        const s = l.find((x) => x.id === seg.step);
        l = s ? (branchesOf(s).find((b) => b.branch === seg.branch)?.steps ?? []) : [];
      }
      return l;
    })();
    const after = siblings[index - 1];
    if (after) return `After “${stepTitle(after, catalog, assistant?.name)}”`;
    if (!list) return "At the start, after the trigger";
    const seg = path[path.length - 1];
    const lane = list.kind === "check" ? BRANCH_WORDS[seg.branch as "yes" | "no"] : list.kind === "ask" ? `“${list.choices[seg.branch as number]?.label ?? "a choice"}”` : "";
    return `First in ${lane}`;
  }

  function addAt(path: ListPath, index: number) {
    if (!hasRoom(flow.steps)) return void showToast(`A flow can have ${FLOW_LIMITS.steps} steps. Remove one first.`);
    openAddStep({
      catalog,
      where: whereWords(path, index),
      hasAssistant: !!flow.assistant_id,
      canBranch: canBranchAt(path),
      onHand: () => openHandSheet({ flow, onHanded: handed }),
      onPick(entry) {
        const before = valuesBefore(flow, path, index);
        const step = stepFromEntry(entry, newStepId(flow.steps), before);
        // A Check or a Wait is ready as it comes; the rest need their words.
        openStepSheet({
          step,
          isNew: true,
          values: before,
          allValues: [...allValues().values()],
          catalog,
          assistant,
          preview: previewValues(flow.id),
          previewFrom: tryWords(flow.trigger).replace(/^Try it on /, "").replace(/^Try it now$/, "the last run"),
          onDone: (s) => void saveSteps(insertStep(flow.steps, path, index, s), entry.money && !flow.money ? { money: true } : {}),
        });
      },
    });
  }

  function editStep(step: FlowStep) {
    openStepSheet({
      step,
      isNew: false,
      values: valuesForStep(flow, step.id),
      allValues: [...allValues().values()],
      catalog,
      assistant,
      preview: previewValues(flow.id),
      previewFrom: tryWords(flow.trigger).replace(/^Try it on /, "").replace(/^Try it now$/, "the last run"),
      onDone: (s) => void saveSteps(replaceStep(flow.steps, s)),
      onRemove: () => void saveSteps(removeStep(flow.steps, step.id)),
    });
  }

  function handed(f: Flow) {
    flow = f;
    void loadAssistant().then(() => alive && paint());
  }

  // ---------- painting ----------
  const wire = () => h("div", { class: "flow-wire", "aria-hidden": "true" });
  const plus = (path: ListPath, index: number, label: string) => {
    const b = h("button", { class: "flow-plus", type: "button", "aria-label": label, disabled: !hasRoom(flow.steps) }, flowIcon("plus"));
    b.addEventListener("click", () => addAt(path, index));
    return b;
  };

  function stepBody(s: FlowStep, look: Lookup): Node | null {
    switch (s.kind) {
      case "tool": {
        const entry = entryFor(s, catalog);
        const first = entry?.fields.find((f) => (s.input[f.key] ?? []).length) ?? null;
        const t = first ? s.input[first.key] : Object.values(s.input).find((x) => x.length);
        return t ? textWithChips(t, look) : h("span", { class: "flow-card__empty" }, "Tap to fill it in");
      }
      case "check": {
        const parts: Array<string | ValueRef> = [];
        // The condition's words, with its values as chips.
        const marker = "\u0000";
        const words = conditionWords(s.condition, (r) => {
          parts.push(r);
          return marker;
        });
        const pieces = words.split(marker);
        const out: Array<string | ValueRef> = [];
        pieces.forEach((p, i) => {
          if (p) out.push(p);
          if (i < parts.length) out.push(parts[i]);
        });
        return textWithChips(out, look);
      }
      case "ask":
        return s.question.length ? textWithChips(s.question, look) : h("span", { class: "flow-card__empty" }, "Tap to write the question");
      case "wait": {
        const at = s.at ? ` at ${s.at}` : "";
        if (s.before) return textWithChips([`Until ${s.days === 0 ? "the day of" : `${s.days} ${s.days === 1 ? "day" : "days"} before`} `, s.before, at], look);
        return h("span", {}, `For ${s.days} ${s.days === 1 ? "day" : "days"}${at}`);
      }
      case "notify":
        return s.text.length ? textWithChips(s.text, look) : h("span", { class: "flow-card__empty" }, "Tap to write what it says");
      case "think":
        return s.task.length ? textWithChips(s.task, look) : h("span", { class: "flow-card__empty" }, "Tap to say what to think about");
      case "assignment":
        return s.brief.length ? textWithChips(s.brief, look) : h("span", { class: "flow-card__empty" }, "Tap to write the brief");
    }
  }

  function stepCard(s: FlowStep, broken: boolean): HTMLElement {
    const look = lookFor(s);
    const thinking = s.kind === "think";
    const lead = thinking && assistant ? face(assistant.avatar, 36, assistant.name) : stepTile(s);
    const metas: Node[] = [];
    const entry = entryFor(s, catalog);
    if (entry?.money) metas.push(h("span", { class: "flow-card__meta" }, flowIcon("lock"), flow.money ? "Reads your spending. Allowed in Settings." : "Reads your spending, which this flow may not do yet."));
    if (thinking) metas.push(h("span", { class: "flow-card__meta" }, assistant ? `${s.web ? "Online · " : ""}Thinking step · uses AI credits` : "Needs an assistant. Hand the flow to one, or remove this step."));
    if (s.kind === "ask") metas.push(h("span", { class: "flow-card__meta" }, `${s.choices.length} choices · waits for your answer`));
    if (s.kind === "assignment") metas.push(h("span", { class: "flow-card__meta" }, "Its lineup waits for your Go"));
    if (broken) metas.push(h("span", { class: "flow-card__meta flow-card__meta--bad" }, "Uses a value it can't reach any more. Tap to pick another."));
    const tag = waitsForGo(s) ? badge({ tone: "you", words: "Waits for your Go" }) : changes(s, catalog) ? badge({ tone: "quiet", words: "Runs on its own" }) : null;
    const card = h(
      "button",
      { class: `flow-card flow-card--${thinking ? "think" : "step"}${broken ? " is-broken" : ""}`, type: "button", "aria-label": `${stepTitle(s, catalog, assistant?.name)}. Change this step` },
      h("span", { class: "flow-card__node" }, lead, h("span", { class: "flow-card__main" }, h("span", { class: "flow-card__title" }, stepTitle(s, catalog, assistant?.name)), h("span", { class: "flow-card__body" }, stepBody(s, look)), ...metas, tag))
    );
    card.addEventListener("click", () => editStep(s));
    const gives = s.kind === "tool" || s.kind === "think" ? givesRow(s.gives) : null;
    return gives ? h("div", { class: "flow-card-wrap" }, card, gives) : card;
  }

  function laneLabel(s: FlowStep, branch: Branch): HTMLElement {
    if (s.kind === "check") return h("span", { class: `flow-lane__label flow-lane__label--${branch}` }, h("span", { class: "flow-lane__dot", "aria-hidden": "true" }), BRANCH_WORDS[branch as "yes" | "no"]);
    const label = s.kind === "ask" ? (s.choices[branch as number]?.label ?? "") : "";
    return h("span", { class: "flow-lane__label flow-lane__label--choice" }, h("span", { class: "flow-lane__dot", "aria-hidden": "true" }), `If you say “${label}”`);
  }

  function list(steps: FlowStep[], path: ListPath, broken: Set<string>): Node[] {
    const out: Node[] = [];
    steps.forEach((s, i) => {
      out.push(stepCard(s, broken.has(s.id)));
      const lanes = branchesOf(s);
      if (lanes.length) {
        out.push(wire());
        out.push(
          h(
            "div",
            { class: "flow-lanes" },
            ...lanes.map((b) => {
              const here: ListPath = [...path, { step: s.id, branch: b.branch }];
              const inner = list(b.steps, here, broken);
              return h(
                "div",
                { class: "flow-lane", role: "group", "aria-label": laneLabel(s, b.branch).textContent ?? "" },
                laneLabel(s, b.branch),
                ...(b.steps.length ? inner : [h("p", { class: "flow-lane__empty" }, "Nothing happens here yet")]),
                plus(here, b.steps.length, `Add a step to ${laneLabel(s, b.branch).textContent}`)
              );
            })
          )
        );
      }
      // Between steps, and after the last one at the top; a lane ends with its own +.
      if (!path.length || i < steps.length - 1) out.push(wire(), plus(path, i + 1, `Add a step after ${stepTitle(s, catalog, assistant?.name)}`), wire());
    });
    return out;
  }

  function hero(): HTMLElement {
    const on = switchInput("Flow on", !flow.paused, (v) => {
      const was = flow.paused;
      flow = { ...flow, paused: !v };
      void save({ paused: !v }, () => (flow = { ...flow, paused: was })).then((ok) => ok && showToast(v ? `${flow.name} is on` : `${flow.name} is off. Run now still works.`));
    });
    const onRow = h("label", { class: "flow-on" }, h("span", {}, "On"), on);
    if (assistant) {
      const take = h("button", { class: "flow-link", type: "button" }, "Take it back");
      take.addEventListener("click", () => void giveBack());
      const p = h("a", { class: "flow-hero__face", href: `#/team/${encodeURIComponent(assistant.id)}`, "aria-label": `${assistant.name}'s page` }, face(assistant.avatar, 64));
      return h(
        "div",
        { class: "flow-hero flow-hero--assistant" },
        h("div", { class: "flow-hero__row" }, p, h("div", {}, h("h1", { class: "page-title flow-hero__name" }, flow.name), h("span", { class: "flow-hero__kind" }, flowKindWords(flow, assistant.name)))),
        h("div", { class: "flow-hero__row flow-hero__row--between" }, h("span", { class: "flow-hero__meta" }, `Handed to ${assistant.name} ${handedWords(flow.handed_at)}. `, take), onRow)
      );
    }
    return h(
      "div",
      { class: "flow-hero" },
      h("h1", { class: "page-title flow-hero__name" }, flow.name),
      h("div", { class: "flow-hero__row flow-hero__row--between" }, h("span", { class: "flow-hero__kind" }, flowKindWords(flow)), onRow)
    );
  }

  function triggerCard(): HTMLElement {
    const card = h(
      "button",
      { class: "flow-card flow-card--trigger", type: "button", "aria-label": `${triggerWords(flow.trigger)}. Change what starts it` },
      h("span", { class: "flow-card__node" }, triggerTile(flow.trigger), h("span", { class: "flow-card__main" }, h("span", { class: "flow-card__title" }, triggerTitle(flow.trigger)), flow.trigger.kind === "event" ? null : h("span", { class: "flow-card__meta" }, flow.trigger.kind === "manual" ? "Run now, a Shortcut, or a try" : "In your time zone")), h("span", { class: "flow-card__chev", "aria-hidden": "true" }, icons.chevronRight()))
    );
    card.addEventListener("click", () => openTriggerSheet({ trigger: flow.trigger, onDone: (t) => void save({ trigger: t }) }));
    const gives = givesRow(flow.trigger_gives);
    return h("div", { class: "flow-card-wrap" }, card, gives);
  }

  function runsSection(): HTMLElement | null {
    if (!runs.length) return null;
    return h(
      "section",
      { class: "flow-sec", "aria-label": "Recent runs" },
      h("h2", { class: "flow-sec__title" }, "Recent runs"),
      h(
        "div",
        { class: "card card--flush list" },
        ...runs.slice(0, 5).map((r) => {
          const b = h("button", { class: "row flow-run-row", type: "button" }, h("span", { class: `flow-mark flow-mark--${r.status}`, "aria-hidden": "true" }), h("span", { class: "row__body" }, h("span", { class: "row__title" }, r.summary ?? r.label), h("span", { class: "row__meta" }, `${runHeading(r.started_at)}${r.dry ? " · a try" : ""}`)), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
          b.addEventListener("click", () => ctx.openRun(r.id));
          return b;
        })
      )
    );
  }

  function handCard(): HTMLElement | null {
    if (assistant) {
      const allowed = (tool: string) => assistant!.allow.includes(tool);
      const changers = new Set<string>();
      walk(flow.steps, (s) => s.kind === "tool" && changes(s, catalog) && changers.add(s.tool));
      const web = (assistant as TeamAssistant & { web?: boolean }).web === true;
      const rows: Array<[string, string]> = [
        ["Look things up online", web ? "On" : "Off"],
        ["Make changes without asking", changers.size && [...changers].every(allowed) ? "Yes" : "Asks first"],
        ["Read your spending", flow.money ? "Only in this flow" : "No"],
      ];
      return h(
        "section",
        { class: "card flow-may" },
        h("h2", { class: "flow-eyebrow" }, `What ${assistant.name} may do here`),
        ...rows.map(([a, b]) => h("div", { class: "flow-may__row" }, h("span", {}, a), h("span", { class: "flow-may__val" }, b))),
        h("a", { class: "flow-link", href: `#/team/${encodeURIComponent(assistant.id)}` }, `Change this on ${assistant.name}'s page`)
      );
    }
    const faces = h("div", { class: "flow-faces", "aria-hidden": "true" }, ...team.slice(0, 3).map((a) => face(a.avatar, 36)));
    const go = h("button", { class: "btn btn--soft btn--sm flow-hand__go", type: "button" }, "Hand to an assistant");
    go.addEventListener("click", () => openHandSheet({ flow, onHanded: handed }));
    return h(
      "section",
      { class: "flow-hand" },
      team.length ? faces : null,
      h("h2", { class: "flow-hand__title" }, "Want it to think, too?"),
      h("p", { class: "flow-hand__text" }, "Hand it to an assistant. It keeps these steps, and can look for a better deal, tell you in its own words and remember what you decided last time."),
      go
    );
  }

  function paint() {
    const broken = brokenSteps(flow);
    const n = countSteps(flow.steps);
    const notesEl = notes.length ? h("div", { class: "flow-drawn", role: "note" }, h("span", { class: "flow-drawn__title" }, "Athena drew this. Check it over:"), h("ul", {}, ...notes.map((x) => h("li", {}, x)))) : null;
    body.replaceChildren(
      hero(),
      notesEl ?? "",
      h("span", { class: "flow-eyebrow" }, "When"),
      triggerCard(),
      wire(),
      plus([], 0, "Add a step at the start"),
      wire(),
      h("span", { class: "flow-eyebrow" }, "Then"),
      ...(flow.steps.length ? list(flow.steps, [], broken) : [h("p", { class: "flow-empty-steps" }, "No steps yet. Tap + to add the first.")]),
      h("span", { class: "flow-done" }, "Done"),
      n >= FLOW_LIMITS.steps ? h("p", { class: "flow-note" }, `That's ${FLOW_LIMITS.steps} steps, the most a flow can have.`) : "",
      runsSection() ?? "",
      handCard() ?? ""
    );
    const tryBtn = h("button", { class: "btn btn--primary flow-foot__try", type: "button", disabled: !flow.steps.length }, icons.play(), tryWords(flow.trigger));
    tryBtn.addEventListener("click", async () => {
      tryBtn.disabled = true;
      try {
        const run = await runFlow(flow.id, true);
        ctx.openRun(run.id);
      } catch (e) {
        tryBtn.disabled = false;
        showToast(e instanceof Error && e.message ? `Couldn't try it: ${e.message}` : "Couldn't try it. Try again.");
      }
    });
    foot.replaceChildren(tryBtn, h("span", { class: "flow-foot__note" }, "A try changes nothing."));
    foot.hidden = false;
  }

  async function giveBack() {
    if (!assistant) return;
    const thinking: string[] = [];
    walk(flow.steps, (s) => s.kind === "think" && thinking.push(s.id));
    const ok = await confirmDialog({
      title: `Take ${flow.name} back from ${assistant.name}?`,
      body: thinking.length ? `It becomes a plain flow again. ${thinking.length === 1 ? "Its thinking step needs" : `Its ${thinking.length} thinking steps need`} an assistant, so ${thinking.length === 1 ? "it won't run" : "they won't run"} until you remove ${thinking.length === 1 ? "it" : "them"} or hand the flow over again.` : "It becomes a plain flow again, with every step you made.",
      confirmLabel: "Take it back",
    });
    if (!ok) return;
    try {
      const name = assistant.name;
      flow = await takeBack(flow.id);
      assistant = null;
      paint();
      showToast(`${flow.name} is a plain flow again. ${name} doesn't run it now.`);
    } catch {
      showToast("Couldn't take it back. Try again.");
    }
  }

  // ---------- the More menu ----------
  more.addEventListener("click", () => {
    if (!flow) return;
    const runNow = h("button", { class: "flow-menu__item", type: "button" }, icons.play(), "Run now");
    const rename = h("button", { class: "flow-menu__item", type: "button" }, icons.pen(), "Rename");
    const giveBackBtn = assistant ? h("button", { class: "flow-menu__item", type: "button" }, icons.restore(), "Take it back") : null;
    const del = h("button", { class: "flow-menu__item flow-menu__item--danger", type: "button" }, icons.trash(), "Delete");
    const sheet = openSheet({ label: flow.name, title: flow.name, body: h("div", { class: "flow-menu" }, runNow, rename, giveBackBtn, del) });
    runNow.addEventListener("click", async () => {
      sheet.close();
      await afterSheet();
      try {
        const run = await runFlow(flow.id, false);
        ctx.openRun(run.id);
      } catch {
        showToast("Couldn't start it. Try again.");
      }
    });
    rename.addEventListener("click", () => {
      sheet.close();
      openRename();
    });
    giveBackBtn?.addEventListener("click", () => {
      sheet.close();
      void giveBack();
    });
    del.addEventListener("click", async () => {
      sheet.close();
      await afterSheet();
      const ok = await confirmDialog({ title: `Delete ${flow.name}?`, body: "Its steps and runs go too. This can't be undone.", confirmLabel: "Delete", danger: true });
      if (!ok) return;
      try {
        await deleteFlow(flow.id);
        showToast(`Deleted ${flow.name}`);
        ctx.back();
      } catch {
        showToast("Couldn't delete that. Try again.");
      }
    });
  });

  function openRename() {
    const input = h("input", { class: "field", type: "text", maxlength: FLOW_LIMITS.name, "aria-label": "Name" }) as HTMLInputElement;
    input.value = flow.name;
    const done = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Save");
    const sheet = openSheet({ label: "Rename", title: "Rename", body: h("div", { class: "flow-sheet" }, input, h("div", { class: "flow-sheet__foot" }, done)) });
    const submit = () => {
      const name = input.value.trim();
      sheet.close();
      if (name && name !== flow.name) void save({ name });
    };
    done.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    setTimeout(() => input.focus(), 50);
  }

  // ---------- loading ----------
  async function loadAssistant() {
    assistant = flow.assistant_id ? await getAssistant(flow.assistant_id).catch(() => null) : null;
  }

  async function load() {
    try {
      const [found, cat, t] = await Promise.all([getFlow(ctx.id), loadCatalog().catch(() => [] as CatalogEntry[]), listTeam().catch(() => [] as TeamAssistant[])]);
      if (!alive) return;
      body.removeAttribute("aria-busy");
      if (!found) {
        const b = h("button", { class: "btn btn--soft", type: "button" }, "Back to your flows");
        b.addEventListener("click", ctx.back);
        return void body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "That flow isn't here any more"), h("p", { class: "empty__sub" }, "It may have been deleted on another device."), b));
      }
      flow = found.flow;
      runs = found.runs;
      catalog = cat;
      team = t;
      await loadAssistant();
      if (alive) paint();
    } catch {
      if (alive) body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "This flow didn't load"), h("p", { class: "empty__sub" }, "Check you're online and try again.")));
    }
  }

  // A run started here or from the run page: the recent runs follow.
  const off = onFlowsChange(() => {
    if (!flow) return;
    void getFlow(ctx.id).then((r) => {
      if (!alive || !r) return;
      runs = r.runs;
      paint();
    });
  });

  void load();
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
