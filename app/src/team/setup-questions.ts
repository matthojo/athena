/**
 * Setup's questions (docs/team.md, "Skills"): 2–4 questions written for this
 * job, each a row of answers to tap plus "Something else" for your own words.
 * Used by setup's second step and by "Give <Name> a skill" on an assistant's
 * page. Answers are kept by question id; answersFor turns them into what the
 * server writes the skill from.
 *
 * Each row is a radio group: tap an answer to pick it, tap it again to clear
 * it, arrow keys move along the row. Picking "Something else" opens a field
 * under the row; Enter there moves on, as in any setup field.
 */
import "../styles/team-questions.css";
import { h } from "../lib/dom";
import { MAX_ANSWER, type TeamAnswer, type TeamQuestion } from "../../../lib/team-skill";

/** Answers by question id. "Something else" is kept as `other:<text>` so the field can come back filled in. */
export type AnswerMap = Record<string, string>;

const OTHER = "other:";

/** What the owner answered, as the server takes it: the question as asked and the answer in their words. Pure. */
export function answersFor(questions: TeamQuestion[], map: AnswerMap): TeamAnswer[] {
  return questions.flatMap((q) => {
    const raw = map[q.id] ?? "";
    const answer = (raw.startsWith(OTHER) ? raw.slice(OTHER.length) : raw).trim();
    return answer ? [{ question: q.question, answer: answer.slice(0, MAX_ANSWER) }] : [];
  });
}

export function questionsForm(questions: TeamQuestion[], map: AnswerMap, onChange: (map: AnswerMap) => void): HTMLElement {
  const rows = questions.map((q, qi) => {
    const labelId = `tq-${q.id}-l`;
    const group = h("div", { class: "tq__choices", role: "radiogroup", "aria-labelledby": labelId });
    const other = h("input", { class: "tq__other", type: "text", maxlength: MAX_ANSWER, placeholder: "Your answer", "aria-label": `${q.question} Your answer`, autocomplete: "off", enterkeyhint: "next", hidden: true }) as HTMLInputElement;
    const values = [...q.choices, ...(q.allowOther ? [OTHER] : [])];
    const chips = values.map((v) => h("button", { class: "tq__chip", type: "button", role: "radio", "data-v": v }, v === OTHER ? "Something else" : v) as HTMLButtonElement);
    const current = () => {
      const raw = map[q.id] ?? "";
      return raw.startsWith(OTHER) ? OTHER : raw;
    };
    const paint = () => {
      const now = current();
      chips.forEach((c, i) => {
        const on = c.dataset.v === now;
        c.setAttribute("aria-checked", on ? "true" : "false");
        // One stop per row: the picked chip, or the first.
        c.tabIndex = on || (!now && i === 0) ? 0 : -1;
      });
      other.hidden = now !== OTHER;
    };
    const set = (v: string) => {
      map = { ...map };
      if (v) map[q.id] = v;
      else delete map[q.id];
      paint();
      onChange(map);
    };
    chips.forEach((c) =>
      c.addEventListener("click", () => {
        const v = c.dataset.v!;
        if (v === OTHER) {
          if (current() === OTHER) return set("");
          set(`${OTHER}${other.value}`);
          other.hidden = false;
          other.focus();
          return;
        }
        set(current() === v ? "" : v);
      })
    );
    group.addEventListener("keydown", (e) => {
      const i = chips.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (i < 0 || !step) return;
      e.preventDefault();
      chips[(i + step + chips.length) % chips.length].focus();
    });
    other.addEventListener("input", () => {
      map = { ...map, [q.id]: `${OTHER}${other.value}` };
      onChange(map);
    });
    const raw = map[q.id] ?? "";
    if (raw.startsWith(OTHER)) other.value = raw.slice(OTHER.length);
    group.append(...chips);
    paint();
    return h("fieldset", { class: "tq", style: `--i:${qi}` }, h("legend", { class: "tq__q", id: labelId }, q.question), group, other);
  });
  return h("div", { class: "tq-list" }, ...rows);
}
