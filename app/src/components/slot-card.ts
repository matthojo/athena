/**
 * Three times for a call or meeting (lib/scheduling.ts findTimes), as a card:
 * whose calendars Athena checked, and a button per time. Tapping one offers
 * "Move here" (when the card is about one of your events and its calendar
 * lets Athena move it), "Book it" (a new meeting at that time, inviting the
 * people on the card, after the confirm sheet in create-sheet.ts) and
 * "Draft a reply with these times", which opens the email sheet
 * (draft-sheet.ts) already written.
 *
 * Moving always asks first (openMoveSheet): "Move ‘Design review’ to Thu
 * 14:00? Guests get an update." Once moved, the card shows a receipt with
 * Undo, which moves it back.
 *
 * Used in Ask (find_times and move_event replies) and in a sheet from Check
 * in's "Suggest times" (openTimesSheet).
 */
import { h } from "../lib/dom";
import "../styles/scheduling.css";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { openDraftSheet, type ReadyDraft } from "./draft-sheet";
import { isSampleMode } from "../db/api";
import { findTimes, moveEvent, prepareCreate, undoMove, type FindInput, type MoveProposal, type MoveResult, type SlotCard } from "../db/scheduling";
import { createReceipt, openCreateSheet } from "./create-sheet";
import { slotBooking } from "../lib/create-event";
import { clockTime, uses12Hour } from "../lib/clock";

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const first = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];

/** "Thu 12 Nov" in `tz`. */
export function dayLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");
}
/** "14:00" in `tz`, or "2:00 pm" on a 12-hour device (lib/clock.ts). */
export function timeLabel(iso: string, tz: string, hour12 = uses12Hour()): string {
  return clockTime(iso, { timeZone: tz, hour12 });
}
/** "Thursday 12 November, 14:00–14:30", for an email. */
function longLabel(s: { start: string; end: string }, tz: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(s.start)).replace(",", "");
  return `${day}, ${timeLabel(s.start, tz)}–${timeLabel(s.end, tz)}`;
}
/** "London time", for when the device is somewhere else. */
const zoneWords = (tz: string) => `${tz.split("/").pop()!.replace(/_/g, " ")} time`;

const lengthWords = (minutes: number) => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes > 60 ? "s" : ""}` : `${minutes} min`);

// ---------- the draft ----------

/** The email that offers the times, picked one first. */
export function timesDraft(card: SlotCard, picked = 0): ReadyDraft {
  const order = [card.slots[picked], ...card.slots.filter((_, i) => i !== picked)].filter(Boolean);
  // To the first guest Athena has an address for; the greeting names everyone.
  const guest = card.people.find((p) => p.email) ?? card.people[0];
  const hello = card.people.length === 1 ? `Hi ${first(card.people[0].name)},` : card.people.length ? `Hi ${card.people.map((p) => first(p.name)).join(" and ")},` : "Hi,";
  const spoken = card.minutes >= 60 && card.minutes % 60 === 0 ? `${card.minutes / 60}-hour` : `${card.minutes}-minute`;
  const what = card.event ? `to move ${card.event.title}` : `for a ${spoken} ${card.people.length ? "call" : "chat"}`;
  const zone = card.tz === deviceZone() ? "" : ` (${zoneWords(card.tz)})`;
  return {
    to: guest ? { name: guest.name, ...(guest.email ? { email: guest.email } : {}) } : "",
    channel: "email",
    subject: card.event ? `New time for ${card.event.title}` : "Times for a call",
    body: [hello, `Would any of these work ${what}?`, order.map((s) => `- ${longLabel(s, card.tz)}${zone}`).join("\n"), "If none of them suit, send me a couple that do.", "Thanks,"].join("\n\n"),
  };
}

/** The email sheet from draft-sheet.ts, already written; it finds the mail accounts that can save it. */
function openTimesDraft(card: SlotCard, picked: number) {
  openDraftSheet(timesDraft(card, picked));
}

// ---------- moving ----------

/**
 * The confirm sheet: "Move ‘Design review’ to Thu 14:00? Guests get an
 * update." Resolves to what moved, or null when the owner didn't.
 */
export function openMoveSheet(p: MoveProposal, tz: string): Promise<MoveResult | null> {
  return new Promise((resolve) => {
    let result: MoveResult | null = null;
    // The length it'll have, shown on both sides.
    const length = p.end ? Date.parse(p.end) - Date.parse(p.start) : 0;
    const to = `${dayLabel(p.start, tz)} ${timeLabel(p.start, tz)}`;
    const cancel = h("button", { class: "btn btn--soft", type: "button" }, "Cancel");
    const move = h("button", { class: "btn btn--primary", type: "button" }, "Move");
    const error = h("p", { class: "move-sheet__error", role: "alert", hidden: true });
    const when = (iso: string | null, label: string, now: boolean) =>
      h(
        "div",
        { class: `move-sheet__when${now ? " is-new" : ""}` },
        h("span", { class: "move-sheet__label" }, label),
        h("span", { class: "move-sheet__day" }, iso ? dayLabel(iso, tz) : "Not known"),
        h("span", { class: "move-sheet__time" }, iso ? `${timeLabel(iso, tz)}${length ? `–${timeLabel(new Date(Date.parse(iso) + length).toISOString(), tz)}` : ""}` : "")
      );
    const body = h(
      "div",
      { class: "move-sheet" },
      h("p", { class: "move-sheet__ask", id: "move-ask" }, `Move ‘${p.title}’ to ${to}?`),
      h("p", { class: "move-sheet__sub" }, "Guests get an update. Only the time changes."),
      h("div", { class: "move-sheet__path" }, when(p.from, "Now", false), h("span", { class: "move-sheet__arrow", "aria-hidden": "true" }, icons.arrowRight()), when(p.start, "Moves to", true)),
      error,
      h("div", { class: "move-sheet__actions" }, cancel, move)
    );
    const sheet = openSheet({ label: `Move ${p.title}`, title: "Move event", body, onClose: () => resolve(result) });
    cancel.addEventListener("click", () => sheet.close());
    move.addEventListener("click", async () => {
      move.setAttribute("disabled", "");
      cancel.setAttribute("disabled", "");
      move.textContent = "Moving…";
      error.hidden = true;
      try {
        result = await moveEvent(p.event_id, p.start, p.end);
        sheet.close();
      } catch (e) {
        error.textContent = e instanceof Error && e.message ? e.message : "Couldn't move it. Try again in a minute.";
        error.hidden = false;
        move.removeAttribute("disabled");
        cancel.removeAttribute("disabled");
        move.textContent = "Try again";
      }
    });
  });
}

/** The receipt: what moved, where to, and Undo (which moves it back). */
export function moveReceipt(r: MoveResult, tz: string): HTMLElement {
  const detail = h("span", { class: "change__detail" }, `Now ${dayLabel(r.after.start, tz)}, ${timeLabel(r.after.start, tz)} · ${isSampleMode() ? "sample, nothing changed" : r.guests ? "guests updated" : `in ${r.where}`}`);
  const undo = h("button", { class: "btn btn--soft btn--sm change__undo", type: "button", "aria-label": `Undo: move ${r.event.title}` }, "Undo");
  const row = h(
    "div",
    { class: "change move-receipt", role: "listitem" },
    h("div", { class: "change__main" }, h("span", { class: "tile tile--sm move-receipt__tile" }, icons.check()), h("span", { class: "change__body" }, h("span", { class: "change__title" }, r.event.title), detail)),
    undo
  );
  undo.addEventListener("click", async () => {
    undo.setAttribute("disabled", "");
    undo.textContent = "Undoing…";
    try {
      await undoMove(r.undo);
      row.classList.add("is-undone");
      detail.textContent = `Back to ${dayLabel(r.before.start, tz)}, ${timeLabel(r.before.start, tz)}`;
      undo.replaceWith(h("span", { class: "change__state" }, icons.restore(), "Undone"));
    } catch (e) {
      undo.removeAttribute("disabled");
      undo.textContent = "Undo";
      showToast(e instanceof Error && e.message ? e.message : "Couldn't move it back. Try again in a moment.", { icon: "restore" });
    }
  });
  return h("div", { class: "card card--flush changes move-receipts", role: "list", "aria-label": "What moved" }, row);
}

// ---------- the card ----------

/** "Checked Priya's calendar" or "Couldn't see Marcus's calendar", one per guest. */
function peopleLine(card: SlotCard): HTMLElement | null {
  if (!card.people.length && !card.unread.length) return null;
  return h(
    "ul",
    { class: "slots__people", "aria-label": "Calendars checked" },
    ...card.people.map((p) =>
      h(
        "li",
        { class: `slots__person${p.seen ? " is-seen" : ""}` },
        p.seen ? icons.check() : icons.circle(),
        p.seen ? `Checked ${first(p.name)}'s calendar` : p.email ? `Couldn't see ${first(p.name)}'s calendar` : `No email for ${first(p.name)}`
      )
    ),
    ...card.unread.map((name) => h("li", { class: "slots__person" }, icons.circle(), `Couldn't read ${name}`))
  );
}

export function slotCard(card: SlotCard): HTMLElement {
  const tz = card.tz;
  const away = tz !== deviceZone();
  const canMove = !!card.event?.can_move;
  const meta = [lengthWords(card.minutes), "in your working hours", away ? zoneWords(tz) : ""].filter(Boolean).join(" · ");
  const receipt = h("div", { class: "slots__receipt" });
  const list = h("div", { class: "slots__list", role: "list" });
  let open = -1;
  const rows: HTMLElement[] = [];

  card.slots.forEach((s, i) => {
    const pick = h(
      "button",
      { class: "slot__pick", type: "button", "aria-expanded": "false", "aria-controls": `slot-actions-${i}` },
      h("span", { class: "slot__day" }, dayLabel(s.start, tz)),
      h("span", { class: "slot__time" }, `${timeLabel(s.start, tz)}–${timeLabel(s.end, tz)}`),
      h("span", { class: "slot__chev", "aria-hidden": "true" }, icons.chevronDown())
    );
    const moveHere = canMove ? h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.calendar(), "Move here") : null;
    // A new meeting, not a move: book that time and invite the people on the card.
    const book = card.event ? null : h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.calendar(), "Book it");
    const draft = h("button", { class: `btn ${canMove || book ? "btn--soft" : "btn--primary"} btn--sm`, type: "button" }, icons.mail(), "Draft a reply with these times");
    const actions = h("div", { class: "slot__actions", id: `slot-actions-${i}`, hidden: true }, moveHere, book, draft);
    const row = h("div", { class: "slot", role: "listitem", style: `--i:${i}` }, pick, actions);
    rows.push(row);
    pick.addEventListener("click", () => {
      const was = open;
      open = was === i ? -1 : i;
      rows.forEach((r, j) => {
        r.classList.toggle("is-open", j === open);
        r.querySelector(".slot__pick")!.setAttribute("aria-expanded", String(j === open));
        (r.querySelector(".slot__actions") as HTMLElement).hidden = j !== open;
      });
    });
    draft.addEventListener("click", () => openTimesDraft(card, i));
    book?.addEventListener("click", async () => {
      const input = slotBooking(card, i);
      const r = await openCreateSheet(prepareCreate(input), { label: `Book ${card.title}` });
      if (!r) return;
      list.hidden = true;
      // The receipt names who was invited: the people on the card with an address.
      receipt.replaceChildren(createReceipt(r, card.people.filter((p) => p.email)));
    });
    moveHere?.addEventListener("click", async () => {
      const r = await openMoveSheet({ event_id: card.event!.id, title: card.event!.title, from: card.event!.starts_at, start: s.start, end: s.end }, tz);
      if (!r) return;
      list.hidden = true;
      receipt.replaceChildren(moveReceipt(r, tz));
    });
    list.append(row);
  });

  const empty = !card.slots.length ? h("p", { class: "slots__empty" }, "Nothing fits in your working hours for these days. Try a longer range, or a shorter call.") : null;
  const why = card.event && !card.event.can_move && card.event.why ? h("p", { class: "slots__why" }, icons.calendar(), card.event.why) : null;
  return h(
    "section",
    { class: "card slots", "aria-label": `Times: ${card.title}` },
    h(
      "header",
      { class: "slots__head" },
      h("span", { class: "tile tile--sm" }, icons.clock()),
      h("span", { class: "slots__heading" }, h("span", { class: "slots__title" }, card.title), h("span", { class: "slots__meta" }, meta))
    ),
    peopleLine(card),
    empty ?? list,
    why,
    receipt
  );
}

/** A move from Ask's move_event, waiting for the owner: the event, its new time, and Move (which asks first). */
export function moveCard(p: MoveProposal, tz = deviceZone()): HTMLElement {
  const go = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Move…");
  const receipt = h("div", { class: "slots__receipt" });
  const head = h(
    "header",
    { class: "slots__head" },
    h("span", { class: "tile tile--sm" }, icons.calendar()),
    h(
      "span",
      { class: "slots__heading" },
      h("span", { class: "slots__title" }, p.title),
      h("span", { class: "slots__meta" }, `${p.from ? `${dayLabel(p.from, tz)} ${timeLabel(p.from, tz)} → ` : ""}${dayLabel(p.start, tz)} ${timeLabel(p.start, tz)}`)
    ),
    go
  );
  const el = h("section", { class: "card slots slots--move", "aria-label": `Move ${p.title}` }, head, receipt);
  go.addEventListener("click", async () => {
    const r = await openMoveSheet(p, tz);
    if (!r) return;
    go.remove();
    receipt.replaceChildren(moveReceipt(r, tz));
  });
  return el;
}

/** Check in's "Suggest times": the card in a sheet, found as it opens. */
export function openTimesSheet(input: FindInput & { label?: string }): void {
  const body = h("div", { class: "times-sheet" }, h("p", { class: "times-sheet__loading", role: "status" }, h("span", { class: "orb orb--thinking", "aria-hidden": "true" }), "Checking calendars…"));
  openSheet({ label: input.label ?? "Suggest times", title: "Suggest times", body });
  findTimes(input)
    .then((card) => body.replaceChildren(slotCard(card)))
    .catch((e) => body.replaceChildren(h("p", { class: "times-sheet__error", role: "alert" }, e instanceof Error && e.message ? e.message : "Couldn't check calendars. Try again in a minute.")));
}
