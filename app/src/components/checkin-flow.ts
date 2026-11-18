/**
 * A check-in, one question to a screen, in a tall sheet (full screen on a
 * phone). It walks the day's plan in order and opens at the first question
 * with no answer. Each answer is saved as it's given (db/checkins.ts queues
 * it with no connection); Skip saves a skip; Back goes to the question
 * before; the close button leaves at any point with what's given kept. The
 * last answer leads to a short done screen and marks the check-in done.
 * Opened from Today's card, a push (#/checkin/<kind>[/<date>]) or the day
 * page's Edit, which starts at the first question.
 */

import "../styles/checkin.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { questionControl, type QuestionControl } from "./checkin-questions";
import { firstOpen, isEmptyValue, ROUTINE_NAME } from "./checkin-rules";
import { answerCheckin, askDeeper, finishCheckin, loadCheckin, type Checkin } from "../db/checkins";
import { localToday } from "../lib/time";
import type { CheckinKind, CheckinValue } from "../../../lib/checkin-types";

const QUEUED = "Saved on this device. It goes to Athena when you're back online.";

let open = false;

export async function openCheckinFlow(kind: CheckinKind, opts: { date?: string; fromStart?: boolean; onClose?: () => void } = {}): Promise<void> {
  if (open) return;
  open = true;
  const date = opts.date ?? localToday();
  let c: Checkin;
  try {
    c = await loadCheckin(date, kind);
  } catch (error) {
    open = false;
    showToast(error instanceof Error ? error.message : "Couldn't open the check-in", { icon: "wifiOff" });
    return;
  }

  let index = opts.fromStart ? 0 : firstOpen(c);
  let queued = false;
  let control: QuestionControl | null = null;

  const body = h("div", { class: "checkin" });
  const sheet = openSheet({
    label: ROUTINE_NAME[kind],
    title: ROUTINE_NAME[kind],
    body,
    variant: "tall",
    onClose: () => {
      open = false;
      opts.onClose?.();
    },
  });
  sheet.dialog.classList.add("checkin-sheet");

  const save = (questionId: string, value: CheckinValue | null) => {
    c = { ...c, answers: { ...c.answers, ...(value ? { [questionId]: { question_id: questionId, value, answered_at: new Date().toISOString() } } : {}) } };
    answerCheckin(date, kind, questionId, value).then(
      (r) => {
        if (r === "queued") queued = true;
      },
      (error) => showToast(error instanceof Error ? error.message : "That answer didn't save", { icon: "wifiOff", timeoutMs: 4000 })
    );
  };

  function go(to: number) {
    index = Math.max(0, to);
    paint();
  }

  function answer(skip: boolean) {
    const q = c.plan[index];
    if (!q) return;
    const value = skip ? null : control?.value() ?? null;
    save(q.id, value && !isEmptyValue(value) ? value : { skipped: true });
    go(index + 1);
  }

  function paint() {
    sheet.setBack(index > 0 ? () => go(index - 1) : null);
    if (!c.plan.length) return paintOff();
    if (index >= c.plan.length) return paintDone();
    const q = c.plan[index];
    const qid = `checkin-q-${q.id}`;
    control = questionControl(q, c.answers[q.id], { labelledBy: qid, deeper: (text) => askDeeper(date, kind, q.id, text) });
    const skip = h("button", { class: "btn btn--ghost", type: "button" }, "Skip");
    skip.addEventListener("click", () => answer(true));
    const last = index === c.plan.length - 1;
    const next = h("button", { class: "checkin__next", type: "submit", "aria-label": last ? "Finish" : "Next" }, last ? icons.check() : icons.arrowRight());
    const form = h(
      "form",
      { class: `checkin__screen checkin__screen--${q.type}`, novalidate: true },
      h(
        "div",
        { class: "checkin__head" },
        h("ol", { class: "checkin__dots", "aria-label": `Question ${index + 1} of ${c.plan.length}` }, ...c.plan.map((x, i) => h("li", { class: "checkin__dot", "data-state": c.answers[x.id] ? "done" : i === index ? "now" : "todo", "aria-current": i === index ? "step" : undefined }))),
        h("h3", { class: "checkin__q", id: qid }, q.prompt)
      ),
      h("div", { class: "checkin__body" }, control.el),
      queued ? h("p", { class: "settings__note checkin__queued", role: "status" }, icons.cloud(), QUEUED) : null,
      h("div", { class: "checkin__foot" }, skip, h("span", { class: "checkin__spacer" }), next)
    ) as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      answer(false);
    });
    // Enter in a written answer is a new line; ⌘/Ctrl+Enter moves on.
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        answer(false);
      }
    });
    body.replaceChildren(form);
    // Typing straight into a written answer; elsewhere the screen reads from the top.
    if (q.type === "text" && !matchMedia("(pointer: coarse)").matches) requestAnimationFrame(() => control?.focus());
  }

  function paintDone() {
    control = null;
    finishCheckin(date, kind).then(
      (r) => {
        if (r === "queued") queued = true;
      },
      () => undefined
    );
    const answered = c.plan.filter((q) => c.answers[q.id] && !("skipped" in c.answers[q.id].value)).length;
    const close = h("button", { class: "btn btn--primary", type: "button" }, "Close");
    close.addEventListener("click", () => sheet.close());
    body.replaceChildren(
      h(
        "div",
        { class: "checkin__done", role: "status" },
        h("span", { class: "tile" }, icons.check()),
        h("h3", { class: "checkin__q" }, kind === "morning" ? "Ready for the day" : "That's today done"),
        h("p", { class: "checkin__lede" }, answered ? `${answered} of ${c.plan.length} answered. You'll find them on ${date === localToday() ? "today's" : "the day's"} page.` : "Nothing answered this time."),
        queued ? h("p", { class: "settings__note checkin__queued" }, icons.cloud(), QUEUED) : null,
        close
      )
    );
    requestAnimationFrame(() => close.focus());
  }

  function paintOff() {
    const set = h("a", { class: "btn btn--primary", href: "#/settings/checkins" }, "Set up check-ins");
    set.addEventListener("click", () => sheet.close());
    body.replaceChildren(
      h(
        "div",
        { class: "checkin__done" },
        h("span", { class: "tile" }, icons.sliders()),
        h("h3", { class: "checkin__q" }, `The ${ROUTINE_NAME[kind].toLowerCase()} is off`),
        h("p", { class: "checkin__lede" }, "Turn it on in Settings, and pick the questions you'd like."),
        set
      )
    );
  }

  paint();
}
