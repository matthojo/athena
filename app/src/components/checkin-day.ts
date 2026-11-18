/**
 * A day's check-in answers on its page (views/days-day.ts): each routine
 * that has answers, as a compact list of question and answer, read-only,
 * with Edit to open that day's check-in at its first question. Skips aren't
 * listed. Hidden when the day has none.
 */

import "../styles/checkin.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { answerLine, ROUTINE_NAME } from "./checkin-rules";
import { loadCheckin, loadCheckinRange, onCheckinsChange, type Checkin } from "../db/checkins";
import type { CheckinKind } from "../../../lib/checkin-types";

export function checkinDaySection(date: string): { el: HTMLElement; destroy: () => void } {
  const el = h("section", { class: "day-sec checkin-day", "aria-labelledby": `checkin-day-${date}`, hidden: true });
  let dead = false;

  function block(kind: CheckinKind, c: Checkin): HTMLElement | null {
    const rows = c.plan.map((q) => ({ q, line: answerLine(q, c.answers[q.id]), deeper: (() => {
      const v = c.answers[q.id]?.value;
      return v && "text" in v && v.deeper?.text ? v.deeper : null;
    })() })).filter((r) => r.line || r.deeper);
    if (!rows.length) return null;
    const edit = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Edit the ${ROUTINE_NAME[kind].toLowerCase()}` }, icons.pen(), "Edit");
    edit.addEventListener("click", () => void import("./checkin-flow").then((m) => m.openCheckinFlow(kind, { date, fromStart: true })));
    return h(
      "div",
      { class: "checkin-day__block" },
      h("div", { class: "checkin-day__head" }, h("h3", { class: "checkin-day__kind" }, ROUTINE_NAME[kind]), edit),
      h(
        "dl",
        { class: "checkin-day__list" },
        ...rows.flatMap((r) => [
          h("dt", {}, r.q.prompt),
          h("dd", {}, r.line ?? ""),
          ...(r.deeper ? [h("dt", { class: "checkin-day__deeper" }, r.deeper.question), h("dd", {}, r.deeper.text ?? "")] : []),
        ])
      )
    );
  }

  async function load() {
    // Only the routines that day already has: reading one would plan it on the server.
    // Offline, the copies kept on this device are all there is, so both are tried.
    const range = await loadCheckinRange(date, date).catch(() => null);
    const kinds = (["morning", "evening"] as const).filter((k) => !range || range[0]?.[k]);
    const got = await Promise.all(kinds.map((k) => loadCheckin(date, k).then((c) => [k, c] as const, () => null)));
    if (dead) return;
    const blocks = got.filter((x): x is readonly [CheckinKind, Checkin] => !!x).map(([k, c]) => block(k, c)).filter((x): x is HTMLElement => !!x);
    el.hidden = !blocks.length;
    el.replaceChildren(h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: `checkin-day-${date}` }, "Check-ins")), ...blocks);
  }

  const off = onCheckinsChange(() => void load());
  void load();
  return {
    el,
    destroy() {
      dead = true;
      off();
    },
  };
}
