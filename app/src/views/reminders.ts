/**
 * Reminders: your own reminders, and this device's notification state
 * (components/notification-settings.ts, the same card as Settings →
 * Notifications, where each kind is switched on or off). The permission
 * prompt only comes from a tap, so nothing here asks on load.
 */

import { h } from "../lib/dom";
import { renderCustomReminders } from "../components/custom-reminders";
import { pushCard } from "../components/notification-settings";

export function renderReminders(): { el: HTMLElement; destroy: () => void } {
  const card = pushCard();
  const choose = h("a", { class: "acct-link reminders__choose", href: "#/settings/notifications" }, "Choose what you get");
  const custom = renderCustomReminders();
  const el = h(
    "div",
    { class: "view reminders" },
    h(
      "header",
      { class: "notes__head" },
      h("div", { class: "notes__title-row" }, h("h1", { class: "page-title" }, "Reminders")),
      h("p", { class: "page-lede" }, "Ask for a reminder at any time, get a morning briefing at 7:30, and hear about birthdays and dates on the days you choose.")
    ),
    card.el,
    choose,
    custom.el,
    h(
      "section",
      { class: "card card--sunken reminders__how" },
      h("h2", { class: "catchup__title" }, "What you'll get"),
      h(
        "ul",
        { class: "reminders__list" },
        h("li", {}, "Your own reminders: a push at the time you pick, once or on repeat. Today's are listed in the briefing too."),
        h("li", {}, "7:30 each morning: today's briefing, written into your notes."),
        h("li", {}, "Birthdays and all-day events: in that morning push, on each “remind me” day."),
        h("li", {}, "Timed events: a push 30 minutes before they start."),
        h("li", {}, "Catch-ups: the briefing lists people you're overdue to speak to. Only people you've set to “Keep in touch” are included."),
        h("li", {}, "Each evening: “How was today?”, unless you've already added a mood, a line or a journal entry."),
        h("li", {}, "Times follow your device's time zone, including when you travel.")
      )
    )
  );

  void card.refresh();
  void custom.refresh();
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    void card.refresh();
    void custom.refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return { el, destroy: () => document.removeEventListener("visibilitychange", onVisible) };
}
