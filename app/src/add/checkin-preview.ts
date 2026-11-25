/**
 * The Add screen's check-in questions (lib/checkin-share.ts): every question in a shared set, grouped by the routine
 * it's asked in (morning, evening, or both), each drawn exactly as the check-in would ask it: its words, then its
 * own control (components/checkin-questions.ts), inert, so the owner sees the slider's sentence, the choices or the
 * empty box with its hint and Go deeper. A question the owner already has is marked, and won't be added twice.
 */
import "../styles/checkin.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { questionControl } from "../components/checkin-questions";
import { TYPE_NAME } from "../components/checkin-rules";
import { CHECKIN_KINDS, type CheckinKind, type CheckinQuestion } from "../../../lib/checkin-types";
import type { SharedCheckinQuestion } from "../../../lib/checkin-share";
import { HAVE_QUESTION, routinesWords } from "./words";

const groupKey = (kinds: readonly CheckinKind[]) => CHECKIN_KINDS.filter((k) => kinds.includes(k)).join("+");
const ORDER = ["morning", "evening", "morning+evening"];

export function checkinPreview(questions: readonly SharedCheckinQuestion[], already: (q: SharedCheckinQuestion) => boolean): HTMLElement {
  const groups = new Map<string, SharedCheckinQuestion[]>();
  for (const q of questions) {
    const k = groupKey(q.kinds);
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  let n = 0;
  const blocks = [...groups].sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b)).map(([key, qs]) => {
    const kinds = key.split("+") as CheckinKind[];
    const icon = kinds.length > 1 ? icons.clock() : kinds[0] === "morning" ? icons.cup() : icons.bed();
    return h(
      "section",
      { class: "add-cq-group", "aria-label": routinesWords(kinds) },
      h("h3", { class: "add-cq-group__title" }, h("span", { class: "add-cq-group__icon", "aria-hidden": "true" }, icon), routinesWords(kinds), h("span", { class: "add-cq-group__count" }, String(qs.length))),
      h(
        "ol",
        { class: "add-cq-list" },
        ...qs.map((q) => {
          const id = `add-cq-${++n}`;
          const have = already(q);
          // Drawn by the check-in's own control, from the question as it would be kept.
          const asked: CheckinQuestion = { ...q, id, mirror: null, preset: false };
          const control = questionControl(asked, undefined, { labelledBy: id, deeper: q.type === "text" && q.deeper ? async () => null : undefined });
          const shown = h("div", { class: "add-cq__control", inert: "", "aria-hidden": "true" }, control.el);
          return h(
            "li",
            { class: `add-cq add-cq--${q.type}${have ? " is-had" : ""}` },
            h("p", { class: "add-cq__q", id }, q.prompt),
            h("p", { class: "add-cq__how" }, TYPE_NAME[q.type], q.type === "text" && q.deeper ? " · Offers Go deeper" : ""),
            have ? h("p", { class: "add-cq__had" }, icons.check(), h("span", {}, HAVE_QUESTION)) : shown
          );
        })
      )
    );
  });
  return h("div", { class: "add-cq-groups" }, ...blocks);
}
