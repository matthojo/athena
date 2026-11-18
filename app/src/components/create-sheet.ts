/**
 * Adding an event (lib/scheduling.ts createEvent), always after the owner
 * confirms:
 *
 *  - openCreateSheet: the confirm sheet. "Add ‘Lunch with Priya’?", then
 *    who gets an invite ("Priya and Marcus get an invite"), the title, the
 *    day and times, the place, and the calendar it goes on (each account's
 *    main one by default, changeable here). Nothing is added until Add.
 *  - createReceipt: what was added, "Open in calendar", and Undo, which
 *    deletes that one event (guests get a cancellation).
 *  - createCard: Ask's create_event reply, waiting for the owner.
 *
 * Used by the slot card's "Book it", Ask, Check in's "Add to calendar" and a
 * to-do's "Block time for this".
 */
import { h } from "../lib/dom";
import "../styles/scheduling.css";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { autoTextarea, field, input, pickerInput, select } from "./fields";
import { isSampleMode } from "../db/api";
import { createEvent, undoCreate, type CreateProposal, type CreateResult } from "../db/scheduling";
import { inviteLine, namesList } from "../lib/create-event";

const first = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];

/** "Thu 12 Nov" in `tz`. */
const dayLabel = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");
/** "14:00" in `tz`. */
const timeLabel = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
/** YYYY-MM-DD in `tz`. */
const dateIn = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** A wall-clock date and time in `tz`, as an instant (ISO). */
export function zonedInstant(date: string, time: string, tz: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (shown - guess.getTime())).toISOString();
}

const calendarKey = (c: { account_id: string; calendar_id: string }) => `${c.account_id}|${c.calendar_id}`;

const KIND_TITLE: Record<CreateProposal["kind"], string> = { meeting: "Add event", booking: "Add to calendar", focus: "Block time" };

/**
 * The confirm sheet. `source` may still be loading (Check in and to-dos look
 * up the calendars, or a free slot, as it opens). With `receiptInSheet`, a
 * successful Add turns the sheet into the receipt; otherwise it closes and
 * resolves with what was added, for the caller to show.
 */
export function openCreateSheet(source: CreateProposal | Promise<CreateProposal>, opts: { receiptInSheet?: boolean; label?: string } = {}): Promise<CreateResult | null> {
  return new Promise((resolve) => {
    let result: CreateResult | null = null;
    const body = h("div", { class: "move-sheet create-sheet" }, h("p", { class: "times-sheet__loading", role: "status" }, h("span", { class: "orb orb--thinking", "aria-hidden": "true" }), "Checking your calendars…"));
    const sheet = openSheet({ label: opts.label ?? "Add an event", title: "Add event", body, onClose: () => resolve(result) });
    const titleEl = body.closest("dialog")?.querySelector(".sheet__title");

    Promise.resolve(source)
      .then((p) => {
        if (titleEl) titleEl.textContent = KIND_TITLE[p.kind];
        paint(p);
      })
      .catch((e) => body.replaceChildren(h("p", { class: "move-sheet__error", role: "alert" }, e instanceof Error && e.message ? e.message : "Couldn't check your calendars. Try again in a minute.")));

    function paint(p: CreateProposal) {
      const tz = p.tz;
      const minutes = Math.round((Date.parse(p.end) - Date.parse(p.start)) / 60_000);
      // A long title wraps rather than running off the edge; Return doesn't add a line.
      const title = autoTextarea(p.title, { maxlength: 300, "aria-label": "Title", autocomplete: "off" });
      title.classList.add("create-sheet__title");
      title.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
      title.addEventListener("input", () => (title.value = title.value.replace(/[\r\n]+/g, " ")));
      const day = pickerInput("date", dateIn(p.start, tz), { "aria-label": "Day" });
      const from = pickerInput("time", timeLabel(p.start, tz), { "aria-label": "Starts", step: 300 });
      const to = pickerInput("time", timeLabel(p.end, tz), { "aria-label": "Ends", step: 300 });
      const where = input("text", p.location ?? "", { maxlength: 500, placeholder: "Add a place", "aria-label": "Where", autocomplete: "off" });
      // An account's only calendar goes by the account; more than one, by name too.
      const options = p.calendars.map((c) => ({ value: calendarKey(c), label: p.calendars.filter((o) => o.account_id === c.account_id).length > 1 ? `${c.name} · ${c.account}` : c.account }));
      const cal = select("Calendar", options, p.calendar ? calendarKey(p.calendar) : "");
      const ask = h("p", { class: "move-sheet__ask", id: "create-ask" });
      const paintAsk = () => (ask.textContent = `Add ‘${title.value.trim() || p.title}’ on ${dayLabel(startIso(), tz)} at ${from.input.value || "–"}?`);
      // The end follows the start, keeping the length, until the owner sets it themselves.
      let length = minutes;
      const startIso = () => zonedInstant(day.input.value, from.input.value || "09:00", tz);
      const endIso = () => {
        const end = zonedInstant(day.input.value, to.input.value || "10:00", tz);
        // An end before the start is the next morning (a late dinner, a night class).
        return Date.parse(end) > Date.parse(startIso()) ? end : new Date(Date.parse(end) + 86_400_000).toISOString();
      };
      from.input.addEventListener("change", () => {
        to.input.value = timeLabel(new Date(Date.parse(startIso()) + length * 60_000).toISOString(), tz);
        to.paint();
        paintAsk();
      });
      to.input.addEventListener("change", () => (length = Math.round((Date.parse(endIso()) - Date.parse(startIso())) / 60_000)));
      day.input.addEventListener("change", paintAsk);
      title.addEventListener("input", paintAsk);
      paintAsk();

      const invites = p.kind === "meeting" && p.attendees.length
        ? h("ul", { class: "create-sheet__who", "aria-label": "Who gets an invite" }, ...p.attendees.map((a) => h("li", { class: "create-sheet__guest", title: a.email }, icons.person(), h("span", {}, a.name || a.email))))
        : null;
      const missing = p.missing.length ? h("p", { class: "create-sheet__note" }, icons.circle(), `No email for ${namesList(p.missing.map(first))}, so ${p.missing.length > 1 ? "they don't" : `${first(p.missing[0])} doesn't`} get an invite.`) : null;
      const why = p.why ? h("p", { class: "slots__why" }, icons.calendar(), p.why) : null;
      const cancel = h("button", { class: "btn btn--soft", type: "button" }, "Cancel");
      const add = h("button", { class: "btn btn--primary", type: "button", disabled: !p.calendar || !p.calendars.length }, "Add") as HTMLButtonElement;
      const error = h("p", { class: "move-sheet__error", role: "alert", hidden: true });
      body.replaceChildren(
        ...([
        ask,
        h("p", { class: "move-sheet__sub create-sheet__invite" }, p.kind === "meeting" && p.attendees.length ? icons.mail() : icons.calendar(), inviteLine(p.attendees, p.kind)),
        invites,
        missing,
        h(
          "div",
          { class: "card card--flush fields create-sheet__fields" },
          field("Title", title),
          field("Day", day.el),
          h("div", { class: "create-sheet__times" }, field("Starts", from.el), field("Ends", to.el)),
          field("Where", where),
          p.calendars.length ? field("Calendar", cal) : null
        ),
        why,
        error,
        h("div", { class: "move-sheet__actions" }, cancel, add),
        ] as Array<HTMLElement | null>).filter((x): x is HTMLElement => !!x)
      );
      body.setAttribute("aria-labelledby", "create-ask");
      cancel.addEventListener("click", () => sheet.close());
      add.addEventListener("click", async () => {
        const picked = p.calendars.find((c) => calendarKey(c) === cal.value) ?? p.calendars[0];
        if (!picked) return;
        const name = title.value.trim();
        if (!name) {
          error.textContent = "Give it a title first.";
          error.hidden = false;
          title.focus();
          return;
        }
        add.disabled = true;
        cancel.setAttribute("disabled", "");
        add.textContent = "Adding…";
        error.hidden = true;
        try {
          result = await createEvent(
            { kind: p.kind, title: name, start: startIso(), end: endIso(), location: where.value.trim() || undefined, description: p.description, attendees: p.attendees },
            { account_id: picked.account_id, calendar_id: picked.calendar_id }
          );
          if (opts.receiptInSheet) {
            if (titleEl) titleEl.textContent = "Added";
            const done = h("button", { class: "btn btn--soft", type: "button" }, "Done");
            done.addEventListener("click", () => sheet.close());
            body.replaceChildren(createReceipt(result, p.attendees), h("div", { class: "create-sheet__done" }, done));
          } else sheet.close();
        } catch (e) {
          error.textContent = e instanceof Error && e.message ? e.message : "Couldn't add it. Try again in a minute.";
          error.hidden = false;
          add.disabled = false;
          cancel.removeAttribute("disabled");
          add.textContent = "Try again";
        }
      });
    }
  });
}

/** The receipt: what was added and when, "Open in calendar", and Undo (which deletes it; guests get a cancellation). */
export function createReceipt(r: CreateResult, attendees: Array<{ name: string; email: string }> = []): HTMLElement {
  const tz = r.tz;
  const names = namesList(attendees.slice(0, r.guests || attendees.length).map((a) => first(a.name || a.email)));
  const when = `${dayLabel(r.start, tz)}, ${timeLabel(r.start, tz)}–${timeLabel(r.end, tz)}`;
  const detail = h("span", { class: "change__detail" }, `${when} · ${isSampleMode() ? "sample, nothing added" : r.guests ? `${names || `${r.guests} guests`} invited` : `in ${r.calendar}`}`);
  const open = h("a", { class: "btn btn--soft btn--sm", href: r.link, target: "_blank", rel: "noopener", "aria-label": `Open ${r.title} in ${r.where}` }, icons.external(), "Open in calendar");
  const undo = h("button", { class: "btn btn--soft btn--sm change__undo", type: "button", "aria-label": `Undo: add ${r.title}` }, "Undo");
  const actions = h("span", { class: "create-receipt__actions" }, open, undo);
  const row = h(
    "div",
    { class: "change move-receipt create-receipt", role: "listitem" },
    h("div", { class: "change__main" }, h("span", { class: "tile tile--sm move-receipt__tile" }, icons.check()), h("span", { class: "change__body" }, h("span", { class: "change__title" }, r.title), detail)),
    actions
  );
  undo.addEventListener("click", async () => {
    undo.setAttribute("disabled", "");
    undo.textContent = "Undoing…";
    try {
      await undoCreate(r.undo);
      row.classList.add("is-undone");
      detail.textContent = r.guests ? `Removed. ${names || "Guests"} ${r.guests === 1 ? "gets" : "get"} a cancellation.` : `Removed from ${r.calendar}.`;
      actions.replaceWith(h("span", { class: "change__state" }, icons.restore(), "Undone"));
    } catch (e) {
      undo.removeAttribute("disabled");
      undo.textContent = "Undo";
      showToast(e instanceof Error && e.message ? e.message : "Couldn't remove it. Try again in a moment.", { icon: "restore" });
    }
  });
  return h("div", { class: "card card--flush changes move-receipts", role: "list", "aria-label": "What was added" }, row);
}

/** Ask's create_event reply: the event, who gets an invite, and Add… (which asks first). */
export function createCard(p: CreateProposal): HTMLElement {
  const go = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Add…");
  const receipt = h("div", { class: "slots__receipt" });
  const meta = `${dayLabel(p.start, p.tz)}, ${timeLabel(p.start, p.tz)}–${timeLabel(p.end, p.tz)}${p.location ? ` · ${p.location}` : ""}`;
  const el = h(
    "section",
    { class: "card slots slots--move slots--create", "aria-label": `Add ${p.title}` },
    h(
      "header",
      { class: "slots__head" },
      h("span", { class: "tile tile--sm" }, icons.calendar()),
      h("span", { class: "slots__heading" }, h("span", { class: "slots__title" }, p.title), h("span", { class: "slots__meta" }, meta)),
      go
    ),
    h("p", { class: "slots__invite" }, p.attendees.length ? icons.mail() : icons.person(), inviteLine(p.attendees, p.kind)),
    receipt
  );
  go.addEventListener("click", async () => {
    const r = await openCreateSheet(p, { label: `Add ${p.title}` });
    if (!r) return;
    go.remove();
    receipt.replaceChildren(createReceipt(r, p.attendees));
  });
  return el;
}
