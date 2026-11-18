/**
 * Going, Maybe or Declined on an event: one segmented control, and a line
 * under it saying where your answer is (sent to the calendar, only in
 * Athena, or why it couldn't be sent), with the one thing to do about it.
 * Every change has Undo in its toast. Declined events leave Home, This week
 * and reminders but stay under Events.
 *
 * Built only with h() and text nodes: titles come from calendars.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { answerEvent, OfflineError } from "../db/records";
import { turnOnAnswering } from "../lib/rsvp-switch";
import type { AthenaEvent, Rsvp } from "../types";

type Answer = Exclude<Rsvp, "none">;

const ANSWERS: Array<{ value: Answer; label: string; icon: IconName }> = [
  { value: "going", label: "Going", icon: "check" },
  { value: "maybe", label: "Maybe", icon: "maybe" },
  { value: "declined", label: "Declined", icon: "close" },
];

const SAYS: Record<Rsvp, string> = { going: "Going", maybe: "Maybe", declined: "Declined", none: "no answer" };

/** "Google Calendar", "Outlook", "iCloud Calendar". */
export function calendarName(provider: string | undefined): string {
  return provider === "outlook-calendar" ? "Outlook" : provider === "google-calendar" ? "Google Calendar" : provider === "icloud-calendar" ? "iCloud Calendar" : "your calendar";
}

/** A one-off event you can answer: not a birthday, anniversary or deadline. */
export function canAnswer(ev: AthenaEvent): boolean {
  return ev.recurrence === "none" && (ev.kind === "appointment" || ev.kind === "other");
}

/** iCloud, one date of a repeating invite with no copy of its own: the server asks "all of them, or just this one?" (icloud-rsvp.ts SERIES_QUESTION). */
const asksSeries = (message: string | null | undefined) => !!message && message.startsWith("This invite repeats.");

const errorText = (err: unknown, fallback: string) => (err instanceof OfflineError ? err.message : err instanceof Error && err.message ? err.message : fallback);

export function rsvpControl(initial: AthenaEvent, onSaved: (ev: AthenaEvent) => void): HTMLElement {
  let ev = initial;
  let busy = false;
  /** You picked "Just this one" for a repeating invite: Apple's Calendar app answers it, Athena keeps yours. */
  let justThisOne = false;
  const buttons = ANSWERS.map((a) => {
    const b = h(
      "button",
      { class: "seg__item rsvp__item", type: "button", role: "radio", "data-answer": a.value, "aria-checked": "false" },
      h("span", { class: "rsvp__icon" }, icons[a.icon]()),
      h("span", {}, a.label)
    ) as HTMLButtonElement;
    b.addEventListener("click", () => void choose(a.value));
    return b;
  });
  const seg = h("div", { class: "seg rsvp__seg", role: "radiogroup", "aria-label": "Your answer" }, ...buttons);
  // Arrow keys move between answers, as in any radio group.
  seg.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    e.preventDefault();
    const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next.focus();
    next.click();
  });
  const note = h("p", { class: "rsvp__note", "aria-live": "polite" });
  const el = h("div", { class: "rsvp" }, seg, note);

  const cal = () => calendarName(ev.rsvp_account?.provider);
  const invite = () => !!ev.calendar_event_id && !!ev.rsvp_account;

  function link(label: string, run: () => void, aria?: string): HTMLElement {
    const b = h("button", { class: "link-btn rsvp__act", type: "button", "aria-label": aria }, label);
    b.addEventListener("click", run);
    return b;
  }

  function paint(sending = false) {
    const mine = ev.rsvp ?? "none";
    el.dataset.answer = mine;
    buttons.forEach((b, i) => {
      const on = ANSWERS[i].value === mine;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on || (mine === "none" && i === 0) ? 0 : -1;
      b.disabled = busy;
    });
    note.className = "rsvp__note";
    const line = (icon: IconName | null, text: string, act?: HTMLElement) => {
      note.hidden = false;
      note.replaceChildren(...(icon ? [icons[icon]()] : []), h("span", { class: "rsvp__text" }, text), ...(act ? [act] : []));
    };
    const off = mine === "declined" ? " · off Home and reminders" : "";
    if (sending) return line(null, `Sending to ${cal()}…`);
    if (!invite()) {
      if (off) return line(null, "Off Home and reminders");
      note.hidden = true;
      return;
    }
    const said = ev.rsvp_calendar ?? "none";
    if (asksSeries(ev.rsvp_error)) {
      if (justThisOne) return line(null, "Answer just this one in Apple's Calendar app. Athena keeps your answer.");
      const choice = h(
        "span",
        { class: "rsvp__choice" },
        link("All of them", () => void send(mine, { series: true }), `Answer every date of this invite ${SAYS[mine]}`),
        link("Just this one", () => {
          justThisOne = true;
          paint();
        }),
      );
      return line(null, "This invite repeats.", choice);
    }
    if (ev.rsvp_error) {
      note.classList.add("rsvp__note--warn");
      return line("wifiOff", `Not sent. ${ev.rsvp_error.replace(/\s*Try again.*$/i, "")}`, link("Try again", () => void send(mine)));
    }
    if (!ev.rsvp_account!.can_send) {
      const where = mine === said || said === "none" ? "Only in Athena" : `Only in Athena · ${cal()} says ${SAYS[said]}`;
      return line(null, where + off, link("Turn on", () => void turnOn(), `Let Athena answer invites in ${cal()}`));
    }
    if (mine === said) return line(mine === "none" ? null : "check", mine === "none" ? `Your answer goes to ${cal()}` : `In ${cal()}${off}`);
    if (mine === "none") return line(null, `${cal()} still says ${SAYS[said]}`);
    line(null, `Not in ${cal()} yet${off}`, link("Send", () => void send(mine)));
  }

  async function send(answer: Rsvp, opts: { undo?: boolean; quiet?: boolean; series?: boolean } = {}) {
    if (busy) return;
    const before = ev;
    busy = true;
    ev = { ...ev, rsvp: answer };
    paint(invite() && !!ev.rsvp_account?.can_send && answer !== (before.rsvp_calendar ?? "none"));
    try {
      const r = await answerEvent(before, answer, opts.series ? { series: true } : {});
      justThisOne = false;
      busy = false;
      ev = r.event;
      onSaved(r.event);
      paint();
      const label = SAYS[answer] === "no answer" ? "Answer cleared" : SAYS[answer];
      const where =
        r.outcome === "sent" ? `sent to ${cal()}${opts.series ? ", every date" : ""}` : r.outcome === "failed" && asksSeries(r.message) ? "all of them, or just this one?" : r.outcome === "failed" ? `couldn't send to ${cal()}` : invite() && r.outcome === "saved" ? "only in Athena" : "";
      const undoTo = r.before;
      if (opts.quiet) return;
      showToast(where ? `${label} · ${where}` : label, {
        icon: r.outcome === "failed" ? "wifiOff" : answer === "declined" ? "close" : answer === "maybe" ? "maybe" : "check",
        timeoutMs: r.outcome === "failed" ? 6000 : 4000,
        action: opts.undo || undoTo === answer ? undefined : { label: "Undo", run: () => void send(undoTo, { undo: true }) },
      });
    } catch (err) {
      busy = false;
      ev = before;
      paint();
      showToast(errorText(err, "Couldn't save your answer"), { icon: "wifiOff", timeoutMs: 5000 });
    }
  }

  async function choose(answer: Answer) {
    if (busy || answer === ev.rsvp) return;
    await send(answer);
  }

  async function turnOn() {
    if (!ev.rsvp_account) return;
    try {
      if ((await turnOnAnswering(ev.rsvp_account.id)) === "done") {
        showToast(`Athena can answer invites in ${cal()}`, { icon: "check" });
        // iCloud sends your answer as soon as it's on: read back where it stands.
        if (ev.rsvp && ev.rsvp !== "none") await send(ev.rsvp, { quiet: true });
      }
    } catch (err) {
      showToast(errorText(err, "Couldn't turn that on"), { icon: "close", timeoutMs: 6000 });
    }
  }

  paint();
  return el;
}
