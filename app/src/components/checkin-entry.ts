/**
 * Today's way into a check-in (components/day-today.ts): a card for each
 * routine that's on, morning then evening, side by side in one row at any
 * time of day. Each says what's left ("2 of 4 left") or that it's done, and
 * opens the flow. With both routines off, Home offers set-up once, until
 * it's dismissed (kept on this device). Made once and kept across Today's
 * repaints; it repaints itself as answers land.
 */

import "../styles/checkin.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { cardDetail, leftToAnswer, plannedCount, ROUTINE_NAME, todayCheckin } from "./checkin-rules";
import { loadCheckin, loadCheckinSettings, onCheckinsChange, type Checkin, type CheckinSettingsView } from "../db/checkins";
import type { CheckinKind } from "../../../lib/checkin-types";

const OFFER_KEY = "athena.checkins.offer";

const offerDismissed = (): boolean => {
  try {
    return localStorage.getItem(OFFER_KEY) === "dismissed";
  } catch {
    return false;
  }
};

export function checkinEntry(opts: { today: string; now: () => Date; place: "home" | "feed" }): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "checkin-entry", hidden: true });
  let settings: CheckinSettingsView | null = null;
  const days: Partial<Record<CheckinKind, Checkin>> = {};
  let dead = false;

  function paint() {
    if (dead || !settings) return;
    const pick = todayCheckin(settings, offerDismissed() || opts.place !== "home");
    if (pick.show === "none") {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    el.classList.toggle("checkin-entry--two", pick.show === "routines" && pick.kinds.length === 2);
    if (pick.show === "offer") {
      const set = h("a", { class: "btn btn--soft btn--sm", href: "#/settings/checkins" }, "Set up");
      const no = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Not now");
      no.addEventListener("click", () => {
        try {
          localStorage.setItem(OFFER_KEY, "dismissed");
        } catch {
          // Private mode: it goes for this visit.
        }
        paint();
      });
      el.replaceChildren(
        h(
          "div",
          { class: "checkin-card checkin-card--offer" },
          h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.chat()),
          h("div", { class: "checkin-card__body" }, h("p", { class: "checkin-card__title" }, "Check in with yourself"), h("p", { class: "checkin-card__meta" }, "A short morning preparation, an evening reflection, or both. Pick the questions.")),
          h("div", { class: "checkin-card__actions" }, set, no)
        )
      );
      return;
    }
    el.replaceChildren(...pick.kinds.map(card));
  }

  function card(kind: CheckinKind): HTMLElement {
    const c = days[kind];
    const total = c?.plan.length || plannedCount(settings![kind]);
    const left = c ? leftToAnswer(c) : total;
    const done = c?.status === "done";
    const started = left < total;
    const detail = done ? "Done" : cardDetail(total, left);
    const go = done ? "Edit" : started ? "Carry on" : "Start";
    const b = h(
      "button",
      { class: `checkin-card${done ? " checkin-card--done" : ""}`, type: "button", "aria-label": `${ROUTINE_NAME[kind]}, ${detail}. ${go}` },
      h("span", { class: "tile tile--sm", "aria-hidden": "true" }, done ? icons.check() : kind === "morning" ? icons.target() : icons.book()),
      h("span", { class: "checkin-card__body" }, h("span", { class: "checkin-card__title" }, ROUTINE_NAME[kind]), h("span", { class: "checkin-card__meta" }, detail)),
      h("span", { class: "checkin-card__go", "aria-hidden": "true" }, go, icons.arrowRight())
    );
    b.addEventListener("click", () => void import("./checkin-flow").then((m) => m.openCheckinFlow(kind, { date: opts.today, fromStart: done })));
    return b;
  }

  async function load() {
    try {
      settings = await loadCheckinSettings();
    } catch {
      return; // No set-up to read (offline with nothing kept, or an older server): no card.
    }
    const kinds = (["morning", "evening"] as const).filter((k) => settings![k].enabled);
    await Promise.all(kinds.map((k) => loadCheckin(opts.today, k).then((c) => (days[k] = c), () => undefined)));
    paint();
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
