/**
 * One step's settings (mockup 6): its words, with chips of values from
 * earlier steps only; for a step that changes something, whether it waits
 * for your Go; and a preview of how it reads with the last thing that ran.
 */
import { h } from "../lib/dom";
import { openSheet } from "../components/sheet";
import { confirmDialog } from "../components/confirm";
import { FLOW_LIMITS, type CatalogEntry, type CheckOp, type FlowStep, type FlowText, type FlowValue, type ValueKind, type ValueRef } from "../../../lib/flow-types";
import type { TeamAssistant } from "../../../lib/team-types";
import { flowIcon, face, segmented, switchInput, type Lookup } from "./parts";
import { textField, valueTray, type TextField } from "./text-field";
import { entryFor, changes } from "./steps";
import { conditionWords, isEmptyText, OPS, plainText, stepTitle } from "./words";
import { refKey } from "./text";
import { countSteps, type AvailableValue } from "./tree";

export interface StepSheetOptions {
  step: FlowStep;
  isNew: boolean;
  /** What this step may use: the trigger's values and earlier steps'. */
  values: readonly AvailableValue[];
  /** Every value in the flow, for labelling one this step can no longer reach. */
  allValues: readonly AvailableValue[];
  catalog: readonly CatalogEntry[];
  assistant: TeamAssistant | null;
  /** What each value was last time, keyed "from.key": the preview. Empty when the server doesn't say. */
  preview: Record<string, string>;
  /** "the last renewal": what the preview was taken from. */
  previewFrom: string;
  onDone: (step: FlowStep) => void;
  onRemove?: () => void;
}

const KINDS_TO_NAME: ReadonlyArray<{ kind: ValueKind; label: string }> = [
  { kind: "text", label: "Words" },
  { kind: "number", label: "A number" },
  { kind: "money", label: "Money" },
  { kind: "date", label: "A date" },
  { kind: "person", label: "A person" },
  { kind: "organisation", label: "An organisation" },
  { kind: "place", label: "A place" },
];

export function makeLookup(values: readonly AvailableValue[], all: readonly AvailableValue[]): Lookup {
  return (r: ValueRef) => {
    const k = refKey(r);
    const here = values.find((v) => refKey(v.ref) === k);
    if (here) return { label: here.label, kind: here.kind, known: true };
    const there = all.find((v) => refKey(v.ref) === k);
    return { label: there ? `${there.label} (not here)` : "a value that's gone", kind: there?.kind ?? "text", known: false };
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "value";

function selectOf(label: string, options: ReadonlyArray<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLElement {
  const sel = h("select", { class: "field flow-select", "aria-label": label }) as HTMLSelectElement;
  for (const o of options) sel.append(h("option", { value: o.value }, o.label));
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

const refFromKey = (values: readonly AvailableValue[], k: string): ValueRef | null => values.find((v) => refKey(v.ref) === k)?.ref ?? null;

export function openStepSheet(o: StepSheetOptions): void {
  let step = structuredClone(o.step) as FlowStep;
  const look = makeLookup(o.values, o.allValues);
  const entry = entryFor(step, o.catalog);
  const fields: Array<{ key: string; field: TextField; required: boolean; label: string }> = [];
  let focused: TextField | null = null;
  const onFocus = (f: TextField) => (focused = f);
  const error = h("p", { class: "flow-sheet__error", role: "alert", hidden: true });
  const preview = h("div", { class: "flow-preview", "aria-live": "polite" });

  const addField = (key: string, label: string, value: FlowText, required: boolean, placeholder?: string) => {
    const field = textField({ label, value, look, onFocus, required, placeholder, onInput: paintPreview });
    fields.push({ key, field, required, label });
    focused ??= field;
    return field.el;
  };

  const title = h("input", { class: "field", type: "text", maxlength: FLOW_LIMITS.name, placeholder: stepTitle({ ...step, title: null }, o.catalog, o.assistant?.name), "aria-label": "Call it" }) as HTMLInputElement;
  title.value = step.title ?? "";

  const body = h("div", { class: "flow-sheet" });
  const sections: Node[] = [];

  // ---------- each kind's settings ----------
  if (step.kind === "tool") {
    const s = step;
    const fs = entry?.fields ?? Object.keys(s.input).map((k) => ({ key: k, label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), kind: "text" as ValueKind, required: false }));
    for (const fd of fs) sections.push(addField(fd.key, fd.label, s.input[fd.key] ?? [], fd.required));
    if (entry?.money) sections.push(h("p", { class: "flow-note" }, flowIcon("lock"), "Reads your spending. It runs only while Ask may read it too (Settings)."));
    if (changes(s, o.catalog)) {
      const verb = s.tool.startsWith("draft") ? "Just draft it" : "Just add it";
      sections.push(
        h(
          "div",
          { class: "flow-sheet__group" },
          h("span", { class: "flow-field__label" }, "When the flow gets here"),
          segmented("When the flow gets here", [{ value: "ask", label: "Wait for my Go" }, { value: "auto", label: verb }] as const, s.go, (v) => (s.go = v)),
          h("p", { class: "flow-note" }, "Changes a flow makes are listed with Undo, like Ask's.")
        )
      );
    }
  } else if (step.kind === "check") {
    const s = step;
    const opts = o.values.map((v) => ({ value: refKey(v.ref), label: v.label }));
    if (!opts.some((x) => x.value === refKey(s.condition.left))) opts.unshift({ value: refKey(s.condition.left), label: look(s.condition.left).label });
    const rightBox = h("div", { class: "flow-sheet__group" });
    const paintRight = () => {
      rightBox.replaceChildren();
      const op = OPS.find((x) => x.op === s.condition.op);
      if (!op?.needsRight) return;
      if (s.condition.op === "up_by_pct") {
        const pct = h("input", { class: "field flow-num", type: "number", min: 1, max: 1000, inputmode: "numeric", "aria-label": "Percent" }) as HTMLInputElement;
        pct.value = String(typeof s.condition.right === "number" ? s.condition.right : 10);
        pct.addEventListener("input", () => ((s.condition.right = Math.max(1, Number(pct.value) || 10)), paintPreview()));
        s.condition.right = Number(pct.value);
        s.condition.against ??= o.values.find((v) => v.kind === "money" || v.kind === "number")?.ref ?? o.values[0]?.ref;
        rightBox.append(
          h("div", { class: "flow-inline" }, pct, h("span", {}, "% on")),
          selectOf("Compared with", opts, s.condition.against ? refKey(s.condition.against) : "", (k) => ((s.condition.against = refFromKey(o.values, k) ?? undefined), paintPreview()))
        );
        return;
      }
      delete s.condition.against;
      const typed = typeof s.condition.right !== "object" || !s.condition.right;
      const typedInput = h("input", { class: "field", type: "text", maxlength: FLOW_LIMITS.text, placeholder: "Type a value", "aria-label": "Value" }) as HTMLInputElement;
      typedInput.value = typed && s.condition.right !== undefined ? String(s.condition.right) : "";
      typedInput.hidden = !typed;
      typedInput.addEventListener("input", () => ((s.condition.right = typedInput.value), paintPreview()));
      const which = selectOf("Compare with", [{ value: "", label: "Something I type" }, ...opts], typed ? "" : refKey(s.condition.right as ValueRef), (k) => {
        const r = refFromKey(o.values, k);
        s.condition.right = r ?? typedInput.value;
        typedInput.hidden = !!r;
        paintPreview();
      });
      rightBox.append(which, typedInput);
    };
    sections.push(
      h("div", { class: "flow-sheet__group" }, h("span", { class: "flow-field__label" }, "Check"), selectOf("Value to check", opts, refKey(s.condition.left), (k) => ((s.condition.left = refFromKey(o.values, k) ?? s.condition.left), paintPreview()))),
      h(
        "div",
        { class: "flow-sheet__group" },
        selectOf(
          "How",
          OPS.map((x) => ({ value: x.op, label: x.words })),
          s.condition.op,
          (v) => {
            s.condition.op = v as CheckOp;
            if (!OPS.find((x) => x.op === v)?.needsRight) delete s.condition.right;
            paintRight();
            paintPreview();
          }
        )
      ),
      rightBox,
      h("p", { class: "flow-note" }, "Two branches follow: “If so” and “Otherwise”. Add steps to either in the flow.")
    );
    paintRight();
  } else if (step.kind === "ask") {
    const s = step;
    sections.push(addField("question", "Question", s.question, true, "Will you be in?"));
    const list = h("div", { class: "flow-choices" });
    const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, flowIcon("plus"), "Add a choice");
    const paintChoices = () => {
      list.replaceChildren(
        ...s.choices.map((c, i) => {
          const input = h("input", { class: "field", type: "text", maxlength: FLOW_LIMITS.name, value: c.label, "aria-label": `Choice ${i + 1}` }) as HTMLInputElement;
          input.addEventListener("input", () => (c.label = input.value));
          const rm = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove choice ${i + 1}`, disabled: s.choices.length <= 2 }, flowIcon("close"));
          rm.addEventListener("click", async () => {
            const n = countSteps(c.steps);
            if (n && !(await confirmDialog({ title: `Remove “${c.label || "this choice"}”?`, body: `Its ${n === 1 ? "step goes" : `${n} steps go`} too.`, confirmLabel: "Remove", danger: true }))) return;
            s.choices.splice(i, 1);
            paintChoices();
          });
          return h("div", { class: "flow-inline" }, input, rm);
        })
      );
      add.hidden = s.choices.length >= FLOW_LIMITS.choices;
    };
    add.addEventListener("click", () => {
      s.choices.push({ label: "", steps: [] });
      paintChoices();
      (list.lastElementChild?.querySelector("input") as HTMLInputElement | null)?.focus();
    });
    paintChoices();
    sections.push(h("div", { class: "flow-sheet__group" }, h("span", { class: "flow-field__label" }, "Choices"), list, add, h("p", { class: "flow-note" }, "Each choice is a branch. The run waits for your answer.")));
  } else if (step.kind === "wait") {
    const s = step;
    const dates = o.values.filter((v) => v.kind === "date" || v.kind === "datetime");
    const days = h("input", { class: "field flow-num", type: "number", min: 0, max: FLOW_LIMITS.waitDays, inputmode: "numeric", "aria-label": "Days" }) as HTMLInputElement;
    days.value = String(s.days);
    days.addEventListener("input", () => (s.days = Math.min(FLOW_LIMITS.waitDays, Math.max(0, Math.round(Number(days.value) || 0)))));
    const at = h("input", { class: "field flow-time", type: "time", "aria-label": "At" }) as HTMLInputElement;
    at.value = s.at ?? "";
    at.addEventListener("input", () => (s.at = at.value || null));
    const dateSel = dates.length ? selectOf("Before", dates.map((d) => ({ value: refKey(d.ref), label: d.label })), s.before ? refKey(s.before) : refKey(dates[0].ref), (k) => (s.before = refFromKey(o.values, k) ?? undefined)) : null;
    const beforeRow = dateSel ? h("div", { class: "flow-inline" }, h("span", {}, "days before"), dateSel) : null;
    const paintMode = () => {
      if (beforeRow) beforeRow.hidden = !s.before;
    };
    sections.push(
      dates.length
        ? segmented("Wait", [{ value: "for", label: "For some days" }, { value: "before", label: "Until before a date" }] as const, s.before ? "before" : "for", (v) => {
            s.before = v === "before" ? (refFromKey(o.values, (dateSel as HTMLSelectElement | null)?.value ?? "") ?? dates[0].ref) : undefined;
            paintMode();
          })
        : h("p", { class: "flow-note" }, "To wait until a day before a date, add a step that gives one first."),
      h("div", { class: "flow-sheet__group" }, h("div", { class: "flow-inline" }, days, h("span", {}, "days")), beforeRow),
      h("div", { class: "flow-sheet__group" }, h("label", { class: "flow-field__label" }, "At"), at, h("p", { class: "flow-note" }, `Up to ${FLOW_LIMITS.waitDays} days. Leave the time empty to carry on at the time it started.`))
    );
    paintMode();
  } else if (step.kind === "notify") {
    sections.push(addField("text", "Tell me", step.text, true, "What the notification says"), h("p", { class: "flow-note" }, "A push and a card on Home, within your quiet hours."));
  } else if (step.kind === "think") {
    const s = step;
    if (o.assistant) sections.push(h("div", { class: "flow-who" }, face(o.assistant.avatar, 32), h("span", {}, `${o.assistant.name} thinks this through, in ${o.assistant.name}'s own words. Thinking steps use AI credits.`)));
    sections.push(addField("task", "What to think about", s.task, true));
    const web = switchInput("Look things up online", s.web, (on) => (s.web = on));
    sections.push(h("label", { class: "flow-switch-row" }, h("span", {}, "Look things up online"), web));
    const givesBox = h("div", { class: "flow-gives-edit" });
    const addGive = h("button", { class: "btn btn--soft btn--sm", type: "button" }, flowIcon("plus"), "Add another");
    const paintGives = () => {
      givesBox.replaceChildren(
        ...s.gives.map((g, i) => {
          const name = h("input", { class: "field", type: "text", maxlength: 40, value: g.label, "aria-label": `Value ${i + 1}` }) as HTMLInputElement;
          name.addEventListener("input", () => (g.label = name.value));
          const kind = selectOf(`Kind of value ${i + 1}`, KINDS_TO_NAME.map((k) => ({ value: k.kind, label: k.label })), g.kind, (k) => (g.kind = k as ValueKind));
          const rm = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove ${g.label || "value"}`, disabled: s.gives.length <= 1 }, flowIcon("close"));
          rm.addEventListener("click", () => (s.gives.splice(i, 1), paintGives()));
          return h("div", { class: "flow-inline" }, name, kind, rm);
        })
      );
      addGive.hidden = s.gives.length >= 6;
    };
    addGive.addEventListener("click", () => {
      s.gives.push({ key: "", label: "", kind: "text" });
      paintGives();
    });
    paintGives();
    sections.push(h("div", { class: "flow-sheet__group" }, h("span", { class: "flow-field__label" }, "Gives you"), givesBox, addGive));
  } else if (step.kind === "assignment") {
    sections.push(addField("brief", "The brief", step.brief, true, "What the lineup should do"), h("p", { class: "flow-note" }, "Starts a Team assignment. Its lineup waits for your Go, as it does from Ask."));
  }

  // ---------- the preview ----------
  function mainText(): FlowText | null {
    const f = fields[0];
    return f ? f.field.get() : null;
  }
  function paintPreview() {
    const values = o.preview;
    const label = (r: ValueRef) => look(r).label;
    let line = "";
    if (step.kind === "check") line = `${conditionWords(step.condition, (r) => values[refKey(r)] ?? label(r))}?`;
    else {
      const t = mainText();
      line = t && !isEmptyText(t) ? plainText(t, label, values) : "";
    }
    const known = Object.keys(values).length > 0;
    preview.replaceChildren(
      h("span", { class: "flow-preview__label" }, known ? `With ${o.previewFrom}` : "How it reads"),
      h("div", { class: "flow-preview__card" }, h("span", { class: "flow-preview__line" }, line || "Fill it in to see how it reads."))
    );
  }

  const tray = valueTray(o.values, () => focused);
  const done = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
  const remove = o.onRemove ? h("button", { class: "btn btn--ghost btn--danger", type: "button" }, flowIcon("trash"), "Remove this step") : null;

  // The tray sits under the first field it fills.
  const firstAt = fields.length ? sections.indexOf(fields[0].field.el) : -1;
  if (firstAt >= 0) sections.splice(firstAt + 1, 0, tray);
  body.append(
    ...sections,
    h("div", { class: "flow-sheet__group" }, h("label", { class: "flow-field__label" }, "Call it", h("span", { class: "flow-field__optional" }, " (optional)")), title),
    preview,
    error,
    h("div", { class: "flow-sheet__foot" }, done, remove)
  );
  paintPreview();

  const verb = o.isNew ? "Add" : "Change";
  const sheet = openSheet({ label: `${verb} a step`, title: stepTitle(step, o.catalog, o.assistant?.name), body, variant: "tall" });

  done.addEventListener("click", () => {
    for (const f of fields) {
      const t = f.field.get();
      if (f.required && isEmptyText(t)) {
        error.textContent = `Fill in “${f.label}” first.`;
        error.hidden = false;
        f.field.focus();
        return;
      }
    }
    if (step.kind === "tool") for (const f of fields) step.input[f.key] = f.field.get();
    else if (step.kind === "ask") {
      step.question = fields[0].field.get();
      step.choices = step.choices.map((c, i) => ({ ...c, label: c.label.trim() || `Choice ${i + 1}` }));
    } else if (step.kind === "notify") step.text = fields[0].field.get();
    else if (step.kind === "think") {
      step.task = fields[0].field.get();
      const used = new Set<string>();
      step.gives = step.gives
        .filter((g) => g.label.trim())
        .map((g): FlowValue => {
          let key = g.key || slug(g.label);
          while (used.has(key)) key = `${key}_2`;
          used.add(key);
          return { key, label: g.label.trim(), kind: g.kind };
        });
      if (!step.gives.length) step.gives = [{ key: "answer", label: "the answer", kind: "text" }];
    } else if (step.kind === "assignment") step.brief = fields[0].field.get();
    step.title = title.value.trim() || null;
    sheet.close();
    o.onDone(step);
  });
  remove?.addEventListener("click", async () => {
    const n = countSteps([step]) - 1;
    const ok = await confirmDialog({
      title: `Remove “${stepTitle(step, o.catalog, o.assistant?.name)}”?`,
      body: n ? `The ${n === 1 ? "step" : `${n} steps`} in its branches go too. Steps after it that use what it gives will need another value.` : "Steps after it that use what it gives will need another value.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    sheet.close();
    o.onRemove?.();
  });
}
