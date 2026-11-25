/**
 * The review inbox: what an agent found but wasn't sure enough to add on its
 * own — a promise in a meeting, a date in an email. Each card says what
 * accepting will do, quotes the words it came from, and how sure the agent
 * was. Add it or dismiss it: buttons, a swipe on a phone (right adds, left
 * dismisses), or A / R on a keyboard for the top card. What Athena worked out
 * about the owner (fact suggestions about "me") is grouped under About you,
 * after the rest. A card that's answered lifts away and the next one rises
 * into its place (lib/finish-motion.ts).
 *
 * The same thing found more than once (a booking email, then its reminder)
 * is one card, "Found 3 times", and its answer covers them all: Add it adds
 * it once (lib/suggestion-similar.ts sameKey). Another date is another card. A card from an
 * email can ignore emails like it in future syncs (components/ignore-sheet.ts),
 * and one put on the calendar with Add to calendar is done, so it leaves.
 */

import { h } from "../lib/dom";
import "../styles/profile.css";
import "../styles/review.css";
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
import { clockOfDay } from "../lib/clock";
import { groupSame } from "../../../lib/suggestion-similar";
import { openIgnoreSheet, senderName } from "../components/ignore-sheet";

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
      return [typeof p.date === "string" ? calendarDate(p.date, true) : "", typeof p.time === "string" ? clockOfDay(p.time) : ""].filter(Boolean).join(" at ");
    case "person":
      return `New person: ${String(p.name ?? "")}`;
    case "link":
      return "Connects two things in your graph";
    case "booking": {
      const start = typeof p.start_local === "string" ? p.start_local : "";
      const day = /^\d{4}-\d{2}-\d{2}/.test(start) ? calendarDate(start.slice(0, 10), true) : "";
      const time = /T(\d{2}:\d{2})/.exec(start)?.[1] ?? "";
      const where = typeof p.start_city === "string" && p.start_city ? ` from ${p.start_city}` : "";
      return `Adds it to a trip${day ? ` · ${day}${time ? ` at ${clockOfDay(time)}` : ""}` : ""}${where}`;
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
      title: "Inbox",
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
  /** A card lifting away; `restore` puts it back when the save fails. */
  function depart(card: HTMLElement, cls: "is-accepted" | "is-rejected" | "is-lifted"): { motion: Promise<unknown>; restore: () => Promise<void> } | null {
    if (card.dataset.leaving !== undefined) return null;
    card.dataset.leaving = "";
    card.classList.add(cls);
    card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    const heading = emptiedHeading(card);
    const motion = (async () => {
      await motionWait(prefersReducedMotion() ? 0 : dur("--dur-fast"));
      await Promise.all([collapse(card), heading ? collapse(heading) : null]);
    })();
    leaving = Promise.all([leaving, motion]);
    const restore = async () => {
      await motion;
      delete card.dataset.leaving;
      card.classList.remove("is-accepted", "is-rejected", "is-lifted");
      card.style.removeProperty("--swipe");
      card.dataset.swipe = "";
      card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = false));
      if (heading) void expand(heading);
      void expand(card);
    };
    return { motion, restore };
  }

  const failed = (error: unknown) => showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });

  /**
   * Answer a card: every find it holds is the same thing, so one answer covers
   * them all. Add it applies the first and marks the rest done (nothing added
   * twice); Not right dismisses them all; Add to calendar marks them all done.
   */
  async function act(group: Suggestion[], action: "accept" | "reject" | "done", card: HTMLElement, how: "tap" | "swipe" = "tap") {
    const going = depart(card, how === "swipe" ? (action === "accept" ? "is-accepted" : "is-rejected") : "is-lifted");
    if (!going) return;
    const [lead, ...repeats] = group;
    try {
      await resolveSuggestion(lead, action);
    } catch (error) {
      await going.restore();
      failed(error);
      return;
    }
    // One at a time: the sample's store is read, changed and written per answer.
    for (const r of repeats) {
      try {
        await resolveSuggestion(r, action === "reject" ? "reject" : "done");
      } catch (error) {
        return failed(error);
      }
    }
    const cleared = group.length > 1 ? `. All ${group.length} cleared from your Inbox` : "";
    if (action === "done") showToast(`Added to your calendar${cleared}`, { icon: "check" });
    else if (action === "accept") showToast(`${ADDED[lead.op]}${cleared}`, { icon: "check" });
    else showToast(group.length > 1 ? `Dismissed all ${group.length}` : "Dismissed", { icon: "close" });
  }

  async function ignore(s: Suggestion, group: Suggestion[], card: HTMLElement) {
    const out = await openIgnoreSheet(s, group.length - 1);
    if (!out) return;
    depart(card, "is-lifted");
    const n = out.dismissed.length;
    const where = out.accounts.length === 1 ? `${out.accounts[0]}'s email rules` : `the email rules on ${out.accounts.length} accounts`;
    showToast(`Added to ${where}. ${n} cleared from your Inbox`, { icon: "check" });
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

  /** The finds each card stands for: the keyboard answers the top one. */
  const cardFor = new WeakMap<Element, Suggestion[]>();

  /** Where one of a card's finds came from, for its "Found 3 times" list. */
  function foundRow(r: Suggestion): HTMLElement {
    const where = describeSource(r.source ?? null);
    const from = [`${where.name}${where.label ? ` · ${where.label}` : ""}`, r.email ? senderName(r.email.from) : ""].filter(Boolean).join(" · ");
    return h(
      "li",
      { class: "suggestion__found" },
      h("span", { class: "suggestion__found-text" }, h("span", { class: "suggestion__found-what" }, r.email?.subject || from), r.email?.subject ? h("span", { class: "suggestion__found-from" }, from) : null),
      h("span", { class: "suggestion__found-when" }, relativeTime(r.created_at))
    );
  }

  function card(s: Suggestion, others: Suggestion[] = []): HTMLElement {
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
    // On the calendar is done: the card leaves once the sheet closes (unless Undo took the event back off).
    addCal?.addEventListener("click", async () => {
      const { known: _known, ...input } = booking!;
      const added = await openCreateSheet(prepareCreate(input), { receiptInSheet: true, label: `Add to calendar: ${s.summary}` });
      if (added) void act(group, "done", c);
    });
    const group = [s, ...others];
    const fromEmail = !!s.email || src.name === "Email digest";
    const ignoreBtn = fromEmail ? h("button", { class: "suggestion__tool", type: "button" }, icons.mail(), "Ignore emails like this") : null;
    ignoreBtn?.addEventListener("click", () => void ignore(s, group, c));
    // The same thing, found more than once (a booking email, then its reminder): one card, one answer.
    const found = others.length ? h("ul", { class: "suggestion__founds", id: `found-${s.id}`, hidden: true }, ...group.map(foundRow)) : null;
    const similar = others.length
      ? h("button", { class: "suggestion__tool suggestion__similar", type: "button", "aria-expanded": "false", "aria-controls": `found-${s.id}` }, icons.copy(), `Found ${group.length} times`, icons.chevronDown())
      : null;
    similar?.addEventListener("click", () => {
      const open = similar.getAttribute("aria-expanded") !== "true";
      similar.setAttribute("aria-expanded", String(open));
      found!.hidden = !open;
    });
    const covers = others.length ? h("p", { class: "suggestion__covers" }, `Your answer covers all ${group.length}`) : null;
    const tools = similar || ignoreBtn ? h("div", { class: "suggestion__tools" }, similar, ignoreBtn) : null;
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
        s.email ? h("span", { class: "suggestion__sender", title: s.email.subject || undefined }, senderName(s.email.from)) : null,
        typeof s.confidence === "number" ? h("span", { class: "provenance__confidence", title: confidenceLabel(s.confidence) }, sureness(s.confidence)) : null
      ),
      tools,
      found,
      covers,
      h("footer", { class: "suggestion__actions" }, suggest ?? addCal, reject, accept),
      h("span", { class: "suggestion__stamp suggestion__stamp--add", "aria-hidden": "true" }, icons.check(), "Add"),
      h("span", { class: "suggestion__stamp suggestion__stamp--skip", "aria-hidden": "true" }, icons.close(), "Dismiss")
    );
    accept.addEventListener("click", () => void act(group, "accept", c));
    reject.addEventListener("click", () => void act(group, "reject", c));
    swipeable(c, (dir) => void act(group, dir === "right" ? "accept" : "reject", c, "swipe"));
    cardFor.set(c, group);
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
      ...groupSame(rest).map(([lead, ...others]) => card(lead, others)),
      ...(mine.length ? [head("review-about", "About you", mine.length)] : []),
      ...groupSame(mine).map(([lead, ...others]) => card(lead, others)),
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
    const group = first ? cardFor.get(first) : undefined;
    if (!first || !group) return;
    if (e.key === "a") act(group, "accept", first);
    else if (e.key === "r") act(group, "reject", first);
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
