/**
 * The review inbox: what an agent found but wasn't sure enough to add on its
 * own — a promise in a meeting, a date in an email. Each card says what
 * accepting will do, quotes the words it came from, and how sure the agent
 * was. Add it or dismiss it: buttons, a swipe on a phone (right adds, left
 * dismisses), or A / R on a keyboard for the top card. What Athena worked out
 * about the owner (fact suggestions about "me") is grouped under About you,
 * after the rest. A card that's answered lifts away and the next one rises
 * into its place (lib/finish-motion.ts).
 */

import { h } from "../lib/dom";
import "../styles/profile.css";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { confidenceLabel } from "../components/commitment-sheet";
import { loadSuggestions, onMemoryChange, resolveSuggestion } from "../db/memory";
import { loadRecords } from "../db/records";
import { calendarDate, relativeTime } from "../lib/format";
import { CHANNEL_META, COMMITMENT_META, SUGGESTION_META } from "../lib/memory-meta";
import { describeSource } from "../lib/sources";
import { collapse, dur, expand, flip, motionWait } from "../lib/finish-motion";
import { prefersReducedMotion } from "../lib/motion";
import type { CommitmentKind, InteractionChannel, Suggestion } from "../types";
import { pageHead } from "../components/page-head";
import { openTimesSheet } from "../components/slot-card";
import { openCreateSheet, zonedInstant } from "../components/create-sheet";
import { bookingAsk } from "../lib/create-event";
import { prepareCreate } from "../db/scheduling";
import { localToday } from "../lib/time";

/** An email or event asking to meet, talk or move something: Check in offers "Suggest times". */
const ASKS_TO_MEET = /\b(meet(ing)?|catch[ -]?up|call|chat|sync|1:1|coffee|reschedul\w*|find a time|another time|new time|move (it|the|our)|push (it|back)|when (are|is) you free|free (on|next|this))\b|\b(grab|find|book|set up|get)\s+(a |an |some )?(\d+\s*min\w*|half an hour|hour|time)\b/i;

/** "Suggest times" for a suggestion that asks to meet: who, from the people it names, and how long, from its words. */
export function meetingAsk(s: Pick<Suggestion, "summary" | "source_quote" | "payload">, names: Map<string, string>): { who: Array<{ name: string }>; minutes: number } | null {
  const words = `${s.summary} ${s.source_quote ?? ""}`;
  if (!ASKS_TO_MEET.test(words)) return null;
  const p = s.payload ?? {};
  const ids = [p.person_id, ...(Array.isArray(p.person_ids) ? p.person_ids : [])].filter((x): x is string => typeof x === "string");
  const who = [...new Set(ids.map((id) => names.get(id)).filter((n): n is string => !!n))].map((name) => ({ name }));
  const m = /(\d{2,3})\s*(?:min|minutes)\b/i.exec(words);
  const minutes = m ? Math.min(240, Math.max(15, Number(m[1]))) : /\b(an|one) hour\b/i.test(words) ? 60 : 30;
  return { who, minutes };
}

const ADDED: Record<Suggestion["op"], string> = {
  commitment: "Added to To do",
  fact: "Remembered",
  interaction: "Catch-up logged",
  event: "Added to Events",
  person: "Added to People",
  link: "Linked",
  booking: "Added to Trips",
  purchase: "Added to Purchases",
};

/** What accepting will do, in a short line built from the payload. */
function consequence(s: Suggestion, names: Map<string, string>): string {
  const p = s.payload;
  const name = (id: unknown) => (typeof id === "string" ? names.get(id) : undefined);
  switch (s.op) {
    case "commitment": {
      const kind = (p.kind as CommitmentKind) ?? "todo";
      const who = name(p.person_id);
      const what = kind === "waiting_on" ? `Waiting on${who ? ` ${who}` : ""}` : kind === "decision" ? "Decision" : `To do${who ? ` · for ${who}` : ""}`;
      return [what, typeof p.due_on === "string" ? `due ${calendarDate(p.due_on)}` : ""].filter(Boolean).join(", ");
    }
    case "fact": {
      if (p.subject_kind === "me") return "Saves it in Settings, under About you";
      const who = p.subject_kind === "me" ? "You" : name(p.subject_id) ?? "Them";
      return `${who} · ${String(p.key ?? "")}: ${String(p.value ?? "")}`;
    }
    case "interaction": {
      const ids = Array.isArray(p.person_ids) ? p.person_ids : [];
      const people = ids.map(name).filter(Boolean).join(", ");
      const channel = CHANNEL_META[(p.channel as InteractionChannel) ?? "other"]?.label ?? "Catch-up";
      return `Logs a catch-up${people ? ` with ${people}` : ""} · ${channel.toLowerCase()}`;
    }
    case "event":
      return [typeof p.date === "string" ? calendarDate(p.date, true) : "", typeof p.time === "string" ? p.time : ""].filter(Boolean).join(" at ");
    case "person":
      return `New person: ${String(p.name ?? "")}`;
    case "link":
      return "Connects two things in your graph";
    case "booking": {
      const start = typeof p.start_local === "string" ? p.start_local : "";
      const day = /^\d{4}-\d{2}-\d{2}/.test(start) ? calendarDate(start.slice(0, 10), true) : "";
      const time = /T(\d{2}:\d{2})/.exec(start)?.[1] ?? "";
      const where = typeof p.start_city === "string" && p.start_city ? ` from ${p.start_city}` : "";
      return `Adds it to a trip${day ? ` · ${day}${time ? ` at ${time}` : ""}` : ""}${where}`;
    }
    case "purchase":
      return `Follows the order${typeof p.retailer === "string" ? ` from ${p.retailer}` : ""} in Purchases`;
  }
}

/** Something Athena worked out about the owner: it belongs under About you. */
const aboutYou = (s: Suggestion) => s.op === "fact" && s.payload.subject_kind === "me";

/**
 * How sure Athena was, in the words Health uses. Everything here was below
 * the bar for adding on its own, so "Very sure" never shows; the exact
 * figure stays in the tooltip.
 */
function sureness(confidence: number): string {
  return confidence >= 0.7 ? "Fairly sure" : "A guess";
}

export function renderReview(): { el: HTMLElement; destroy: () => void } {
  let items: Suggestion[] = [];
  let names = new Map<string, string>();
  const count = h("span", { class: "page-count" });
  const stack = h("div", { class: "review__stack" });
  const el = h(
    "div",
    { class: "view review" },
    pageHead({
      title: "Review inbox",
      count,
      lede: "Things Athena noticed but wasn't sure about. Add the right ones. Anything you mark Not right won't come back.",
    }),
    stack
  );

  // A card leaving: it lifts away (or flies off the way it was swiped), its
  // space folds so the next card rises into place, and an emptied heading
  // follows. The save runs alongside; the list repaints once the motion is
  // over, so nothing jumps.
  let leaving: Promise<unknown> = Promise.resolve();
  async function act(s: Suggestion, action: "accept" | "reject", card: HTMLElement, how: "tap" | "swipe" = "tap") {
    if (card.dataset.leaving !== undefined) return;
    card.dataset.leaving = "";
    card.classList.add(how === "swipe" ? (action === "accept" ? "is-accepted" : "is-rejected") : "is-lifted");
    card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    const heading = emptiedHeading(card);
    const motion = (async () => {
      await motionWait(prefersReducedMotion() ? 0 : dur("--dur-fast"));
      await Promise.all([collapse(card), heading ? collapse(heading) : null]);
    })();
    leaving = Promise.all([leaving, motion]);
    try {
      await resolveSuggestion(s, action);
      showToast(action === "accept" ? ADDED[s.op] : "Dismissed", { icon: action === "accept" ? "check" : "close" });
    } catch (error) {
      await motion;
      delete card.dataset.leaving;
      card.classList.remove("is-accepted", "is-rejected", "is-lifted");
      card.style.removeProperty("--swipe");
      card.dataset.swipe = "";
      card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = false));
      if (heading) void expand(heading);
      void expand(card);
      showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }

  /** A group heading whose cards are all leaving once this one goes. */
  function emptiedHeading(card: HTMLElement): HTMLElement | null {
    let head: HTMLElement | null = null;
    for (let el = card.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.classList.contains("review__group")) {
        head = el as HTMLElement;
        break;
      }
    }
    if (!head) return null;
    for (let el = head.nextElementSibling; el && !el.classList.contains("review__group"); el = el.nextElementSibling) {
      if (el !== card && el.classList.contains("suggestion") && (el as HTMLElement).dataset.leaving === undefined) return null;
    }
    return head;
  }

  function card(s: Suggestion): HTMLElement {
    const meta = SUGGESTION_META[s.op];
    const src = describeSource(s.source ?? null);
    const accept = h("button", { class: "btn btn--primary", type: "button" }, icons.check(), "Add it");
    const reject = h("button", { class: "btn btn--ghost", type: "button" }, "Not right");
    const meet = meetingAsk(s, names);
    const suggest = meet ? h("button", { class: "btn btn--soft suggestion__times", type: "button" }, icons.clock(), "Suggest times") : null;
    suggest?.addEventListener("click", () => openTimesSheet({ ...meet!, label: `Suggest times: ${s.summary}` }));
    // A booking or an appointment (a table, the dentist, a class): add it, prefilled, with no one invited.
    const booking = meet ? null : bookingAsk(s, localToday(), (date, time) => zonedInstant(date, time, Intl.DateTimeFormat().resolvedOptions().timeZone));
    const addCal = booking ? h("button", { class: "btn btn--soft suggestion__times", type: "button" }, icons.calendar(), "Add to calendar") : null;
    addCal?.addEventListener("click", () => {
      const { known: _known, ...input } = booking!;
      void openCreateSheet(prepareCreate(input), { receiptInSheet: true, label: `Add to calendar: ${s.summary}` });
    });
    const c = h(
      "article",
      { class: "card suggestion", "data-op": s.op, "data-flip": `s:${s.id}`, tabindex: -1, "aria-label": s.summary },
      h(
        "header",
        { class: "suggestion__head" },
        h("span", { class: "tile tile--sm" }, icons[meta.icon]()),
        h("span", { class: "suggestion__kind" }, meta.label),
        h("span", { class: "suggestion__when" }, relativeTime(s.created_at))
      ),
      // Under About you the group heading says whose it is.
      h("p", { class: "suggestion__summary" }, aboutYou(s) ? s.summary.replace(/^About you · /, "") : s.summary),
      h("p", { class: "suggestion__effect" }, consequence(s, names)),
      s.source_quote ? h("blockquote", { class: "provenance__quote" }, `“${s.source_quote.replace(/^[“"]|[”"]$/g, "")}”`) : null,
      h(
        "p",
        { class: "suggestion__source" },
        icons.sparkle(),
        h("span", {}, `From ${src.name}${src.label ? ` · ${src.label}` : ""}`),
        typeof s.confidence === "number" ? h("span", { class: "provenance__confidence", title: confidenceLabel(s.confidence) }, sureness(s.confidence)) : null
      ),
      h("footer", { class: "suggestion__actions" }, suggest ?? addCal, reject, accept),
      h("span", { class: "suggestion__stamp suggestion__stamp--add", "aria-hidden": "true" }, icons.check(), "Add"),
      h("span", { class: "suggestion__stamp suggestion__stamp--skip", "aria-hidden": "true" }, icons.close(), "Dismiss")
    );
    accept.addEventListener("click", () => void act(s, "accept", c));
    reject.addEventListener("click", () => void act(s, "reject", c));
    swipeable(c, (dir) => void act(s, dir === "right" ? "accept" : "reject", c, "swipe"));
    return c;
  }

  let painted = false;
  function paint() {
    const animate = painted;
    painted = true;
    const show = (...nodes: Node[]) => (animate ? flip(stack, () => stack.replaceChildren(...nodes), { enter: true }) : stack.replaceChildren(...nodes));
    count.textContent = items.length ? String(items.length) : "";
    if (!items.length) {
      show(
        h(
          "div",
          { class: animate ? "empty reveal" : "empty" },
          h("span", { class: "tile" }, icons.inbox()),
          h("p", { class: "empty__title" }, "All clear"),
          h("p", { class: "empty__sub" }, "When a collection isn't sure about something it found, like a promise in a meeting or a date in an email, it asks you here before adding it.")
        )
      );
      return;
    }
    // items is already in this order (load), so the keyboard's top card matches.
    const mine = items.filter(aboutYou);
    const rest = items.filter((s) => !aboutYou(s));
    const head = (id: string, title: string, n: number) =>
      h("div", { class: "group__head review__group", "data-flip": `head:${id}` }, h("h2", { class: "group__label", id }, title), h("span", { class: "page-count" }, String(n)));
    show(
      ...(mine.length && rest.length ? [head("review-rest", "Found in your sources", rest.length)] : []),
      ...rest.map(card),
      ...(mine.length ? [head("review-about", "About you", mine.length)] : []),
      ...mine.map(card),
      h("p", { class: "review__hint" }, "On a keyboard: A adds the top card, R dismisses it.")
    );
  }

  async function load() {
    const [{ items: loaded }, { items: people }] = await Promise.all([loadSuggestions(), loadRecords("person")]);
    items = [...loaded.filter((s) => !aboutYou(s)), ...loaded.filter(aboutYou)];
    names = new Map(people.map((p) => [p.id, p.name]));
    // Let a leaving card finish before the list is redrawn without it.
    await leaving;
    paint();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.matches("input, textarea, select") || t.isContentEditable)) return;
    const first = stack.querySelector<HTMLElement>(".suggestion:not([data-leaving])");
    const s = items[[...stack.querySelectorAll(".suggestion")].indexOf(first as Element)];
    if (!first || !s) return;
    if (e.key === "a") act(s, "accept", first);
    else if (e.key === "r") act(s, "reject", first);
  };
  window.addEventListener("keydown", onKey);

  stack.replaceChildren(h("div", { class: "card suggestion" }, h("span", { class: "skeleton", style: "height:14px;width:40%" }), h("span", { class: "skeleton", style: "height:22px;width:85%;margin-top:12px" })));
  void load();
  const unsub = onMemoryChange((topic) => {
    if (topic === "suggestion" || topic === "all") void load();
  });
  return {
    el,
    destroy: () => {
      unsub();
      window.removeEventListener("keydown", onKey);
    },
  };
}

/** Horizontal swipe with a little rubber band; past 96px (or a flick) it commits. */
function swipeable(card: HTMLElement, commit: (dir: "left" | "right") => void) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking: "pending" | "x" | "y" | null = null;
  let t0 = 0;
  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || (e.target as Element).closest("button")) return;
    tracking = "pending";
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    t0 = performance.now();
  });
  card.addEventListener("pointermove", (e) => {
    if (!tracking) return;
    const x = e.clientX - startX;
    const y = e.clientY - startY;
    if (tracking === "pending") {
      if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
      tracking = Math.abs(x) > Math.abs(y) ? "x" : "y";
      if (tracking === "x") {
        card.setPointerCapture(e.pointerId);
        card.classList.add("is-swiping");
      }
    }
    if (tracking !== "x") return;
    dx = x;
    card.style.setProperty("--swipe", `${dx}px`);
    card.dataset.swipe = dx > 24 ? "right" : dx < -24 ? "left" : "";
  });
  const end = () => {
    if (tracking !== "x") {
      tracking = null;
      return;
    }
    tracking = null;
    card.classList.remove("is-swiping");
    const v = Math.abs(dx) / Math.max(1, performance.now() - t0);
    if (Math.abs(dx) > 96 || (Math.abs(dx) > 32 && v > 0.6)) commit(dx > 0 ? "right" : "left");
    else {
      card.style.setProperty("--swipe", "0px");
      card.dataset.swipe = "";
    }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}
