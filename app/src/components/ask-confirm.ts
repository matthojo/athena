/**
 * Ask's confirm cards (security review M7): the three things the assistant
 * may not do on its own. Each waits here for the owner's tap, the way a
 * move or a new event does (slot-card.ts, create-sheet.ts):
 *
 *  - an answer to an invite: the tap saves it, and sends it to the calendar
 *    when that account allows it (POST /api/events/:id/rsvp);
 *  - an email for Gmail or Outlook Drafts: the tap opens the draft to read
 *    and edit, and Save there puts it in Drafts (draft-sheet.ts);
 *  - a note for Google Docs or Notion: the tap sends it (POST /api/documents);
 *  - spending, health figures, a day's entry or a meter reading from a
 *    sentence (lib/ask-logging.ts): the tap saves it through the same routes
 *    as the manual-entry forms. Health is laid over what was typed in for
 *    that day, read at the tap, so nothing typed before is lost. Edit opens
 *    that form filled in from the card instead (owner, 14 Nov); its save
 *    gives the same receipt, and closing it leaves the card as it was.
 *
 * Built only with h() and text nodes: titles come from calendars and notes.
 */
import { h } from "../lib/dom";
import "../styles/scheduling.css";
import { icons } from "./icons";
import { showToast } from "./toast";
import { openDraftSheet } from "./draft-sheet";
import { rsvpControl } from "./rsvp-control";
import { isSampleMode } from "../db/api";
import { answerEvent } from "../db/records";
import { OPEN_IN, PROVIDER_NAME, sendToDocuments, undoDocument } from "../db/documents";
import { addSpending, removeSpending } from "../db/life";
import { clearManualHealth, loadManualHealth, saveManualHealth } from "../db/health";
import { addDayEntry, daysChanged, removeDayEntry } from "../db/days-app";
import { addEntry } from "../db/days";
import { addReading, loadHouse, removeReading } from "../db/house";
import { openSpendingSheet } from "./spending-sheet";
import { openHealthLogSheet } from "./health-log-sheet";
import { openDayEntrySheet } from "./day-entry-sheet";
import { openMeterReadingSheet } from "./meter-reading-sheet";
import { confirmWords } from "../../../lib/assistant-confirm";
import { healthFigureWords, mergeHealth, type LoggedHealth, type LogCard } from "../../../lib/ask-logging";
import type { AskConfirmCard as ConfirmCard, AthenaEvent } from "../types";

const ENTRY_ICON = { watched: icons.film, listened: icons.headphones, read: icons.book, played: icons.game, other: icons.star } as const;

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** One row saying what happened, with at most one thing to do about it. */
function receipt(title: string, detail: string, act?: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "change move-receipt", role: "listitem" },
    h("div", { class: "change__main" }, h("span", { class: "tile tile--sm move-receipt__tile" }, icons.check()), h("span", { class: "change__body" }, h("span", { class: "change__title" }, title), h("span", { class: "change__detail" }, detail))),
    act ?? null
  );
}

/** What a logging card saved: where to see it, and how to take it back (none for a day's entry in sample mode). */
interface Logged {
  detail: string;
  href: string;
  open: string;
  undo?: () => Promise<void>;
}

/** Save a logging card, the way the manual-entry forms do. */
async function saveLog(card: LogCard): Promise<Logged> {
  if (card.kind === "log_spending") {
    const p = await addSpending({ date: card.date, amount: card.amount, currency: card.currency, category: card.category, ...(card.merchant ? { merchant: card.merchant } : {}) });
    return { detail: "Added to Money", href: "#/money", open: "Open Money", undo: () => removeSpending(p.date, p.id) };
  }
  if (card.kind === "log_health") {
    // Read now, not when Ask wrote the card: the day may have changed since. Only what was said changes.
    const before = await loadManualHealth(card.date);
    await saveManualHealth(card.date, mergeHealth(before, card.figures));
    daysChanged([card.date]);
    return {
      detail: "Saved to Health",
      href: `#/days/${card.date}`,
      open: "Open the day",
      undo: async () => {
        if (before) await saveManualHealth(card.date, before);
        else await clearManualHealth(card.date);
        daysChanged([card.date]);
      },
    };
  }
  if (card.kind === "log_entry") {
    const open = { detail: "Added to the day", href: `#/days/${card.date}`, open: "Open the day" };
    if (isSampleMode()) {
      await addDayEntry(card.date, card.entry);
      daysChanged([card.date]);
      return open;
    }
    const r = await addEntry(card.date, card.entry);
    daysChanged([card.date]);
    // Null when it folded into the same thing from another source that day: nothing of its own to take back.
    const id = r.id;
    return id ? { ...open, undo: () => removeDayEntry(card.date, id).then(() => daysChanged([card.date])) } : open;
  }
  const next = await addReading({ fuel: card.fuel, date: card.date, value: card.value, unit: card.unit });
  const made = next.find((r) => r.fuel === card.fuel && r.date === card.date);
  return { detail: "Added to House", href: "#/house", open: "Open House", ...(made ? { undo: () => removeReading(made.id).then(() => undefined) } : {}) };
}

/**
 * Open the card's own form filled in from it (owner, 14 Nov). `saved` gets the receipt's title, from what the
 * form saved rather than what Ask heard, and the same receipt as the card's button; closing the form calls nothing.
 */
async function editLog(card: LogCard, saved: (title: string, logged: Logged) => void): Promise<void> {
  const title = (c: LogCard) => confirmWords(c).title;
  if (card.kind === "log_spending") {
    openSpendingSheet(
      (p) => saved(title({ ...card, date: p.date, amount: p.amount, currency: p.currency, category: p.category, merchant: p.merchant }), { detail: "Added to Money", href: "#/money", open: "Open Money", undo: () => removeSpending(p.date, p.id) }),
      { date: card.date, start: { merchant: card.merchant, amount: card.amount, currency: card.currency, category: card.category } }
    );
    return;
  }
  if (card.kind === "log_health") {
    // The form reads the day's typed figures itself and lays the card's over them: the same merge as Save.
    openHealthLogSheet(
      ({ date, before, figures }) => {
        daysChanged([date]);
        const changed = Object.fromEntries(Object.entries(figures ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before?.[k as keyof typeof before]))) as LoggedHealth;
        saved(healthFigureWords(changed).join(" · ") || title(card), {
          detail: figures ? "Saved to Health" : "Cleared from Health",
          href: `#/days/${date}`,
          open: "Open the day",
          undo: async () => {
            if (before) await saveManualHealth(date, before);
            else await clearManualHealth(date);
            daysChanged([date]);
          },
        });
      },
      { date: card.date, start: card.figures }
    );
    return;
  }
  if (card.kind === "log_entry") {
    openDayEntrySheet(
      card.date,
      (entry, id) => {
        daysChanged([card.date]);
        saved(title({ ...card, entry }), { detail: "Added to the day", href: `#/days/${card.date}`, open: "Open the day", ...(id ? { undo: () => removeDayEntry(card.date, id).then(() => daysChanged([card.date])) } : {}) });
      },
      { kind: card.entry.kind, start: { title: card.entry.title, subtitle: card.entry.subtitle, minutes: card.entry.minutes } }
    );
    return;
  }
  // The form checks against the readings before, as it does on House.
  const readings = (await loadHouse()).readings ?? [];
  openMeterReadingSheet(
    readings,
    (_next, made) => {
      const words = made ? title({ kind: "log_reading", date: made.date, fuel: made.fuel, value: made.value, unit: made.unit }) : title(card);
      saved(words, { detail: "Added to House", href: "#/house", open: "Open House", ...(made ? { undo: () => removeReading(made.id).then(() => undefined) } : {}) });
    },
    { fuel: card.fuel, start: { value: card.value, unit: card.unit, date: card.date } }
  );
}

/** A thing the assistant prepared, waiting for the owner. Nothing has happened until the button is tapped. */
export function confirmCard(card: ConfirmCard): HTMLElement {
  const words = confirmWords(card);
  const go = h("button", { class: "btn btn--primary btn--sm", type: "button" }, words.action) as HTMLButtonElement;
  const done = h("div", { class: "slots__receipt" });
  const icon =
    card.kind === "rsvp"
      ? icons.calendar()
      : card.kind === "draft"
        ? icons.mail()
        : card.kind === "log_spending"
          ? icons.wallet()
          : card.kind === "log_health"
            ? icons.heart()
            : card.kind === "log_entry"
              ? ENTRY_ICON[card.entry.kind]()
              : card.kind === "log_reading"
                ? icons.home()
                : icons.external();
  const logging = card.kind === "log_spending" || card.kind === "log_health" || card.kind === "log_entry" || card.kind === "log_reading";
  const edit = logging ? (h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Edit first: ${words.label}` }, "Edit") as HTMLButtonElement) : null;
  const head = h(
    "header",
    { class: "slots__head" },
    h("span", { class: "tile tile--sm" }, icon),
    h("span", { class: "slots__heading" }, h("span", { class: "slots__title" }, words.title), h("span", { class: "slots__meta" }, words.meta)),
    edit ? h("span", { style: "display:flex;gap:var(--space-xs);flex-shrink:0" }, edit, go) : go
  );
  const el = h("section", { class: "card slots slots--move", "aria-label": words.label }, head, done);

  const run = async (work: () => Promise<void>, failed: string) => {
    go.disabled = true;
    if (edit) edit.disabled = true;
    try {
      await work();
    } catch (e) {
      go.disabled = false;
      if (edit) edit.disabled = false;
      showToast(errorText(e, failed), { icon: "close", timeoutMs: 6000 });
    }
  };

  /** A logging card's receipt: where it went, Open, and Undo where there's something to take back. */
  const showLogged = (title: string, saved: Logged) => {
    const open = h("a", { class: "btn btn--soft btn--sm", href: saved.href }, saved.open);
    const row = receipt(title, saved.detail);
    const undo = saved.undo ? (h("button", { class: "btn btn--ghost btn--sm change__undo", type: "button", "aria-label": `Undo: ${words.label}` }, "Undo") as HTMLButtonElement) : null;
    undo?.addEventListener("click", async () => {
      undo.disabled = true;
      try {
        await saved.undo!();
        row.classList.add("is-undone");
        undo.replaceWith(h("span", { class: "change__state" }, icons.restore(), "Undone"));
        open.remove();
      } catch (e) {
        undo.disabled = false;
        showToast(errorText(e, "Couldn't undo that. Try again in a moment."), { icon: "restore" });
      }
    });
    go.remove();
    edit?.remove();
    done.replaceChildren(row, h("div", { style: "display:flex;gap:var(--space-xs);justify-content:flex-end;flex-wrap:wrap" }, open, undo));
  };

  edit?.addEventListener("click", () => {
    if (card.kind !== "log_spending" && card.kind !== "log_health" && card.kind !== "log_entry" && card.kind !== "log_reading") return;
    edit.disabled = true;
    void editLog(card, showLogged).then(
      () => (edit.disabled = false),
      (e) => {
        edit.disabled = false;
        showToast(errorText(e, "Couldn't open that"), { icon: "close", timeoutMs: 6000 });
      }
    );
  });

  go.addEventListener("click", () => {
    if (card.kind === "draft") {
      // The sheet is where it's read, edited and saved to Drafts; nothing is saved by opening it.
      openDraftSheet({ draft: card.draft });
      return;
    }
    if (card.kind === "rsvp") {
      void run(async () => {
        if (isSampleMode()) {
          go.remove();
          done.replaceChildren(receipt(card.title, "Sample mode: nothing was answered"));
          return;
        }
        const r = await answerEvent({ id: card.event_id } as AthenaEvent, card.answer, card.series ? { series: true } : {});
        go.remove();
        // The same control as the event's page: where the answer went, and a way to change it.
        done.replaceChildren(rsvpControl(r.event, () => undefined));
      }, "Couldn't save your answer");
      return;
    }
    if (logging) {
      void run(async () => showLogged(words.title, await saveLog(card)), "Couldn't save that");
      return;
    }
    const to = card.to;
    void run(async () => {
      const r = await sendToDocuments(card.note_id, card.title, to);
      const where = PROVIDER_NAME[to];
      const open = h("a", { class: "btn btn--soft btn--sm", href: r.export.url, target: "_blank", rel: "noopener noreferrer" }, OPEN_IN[to]);
      const undo = h("button", { class: "btn btn--ghost btn--sm change__undo", type: "button", "aria-label": `Undo: send ${card.title}` }, "Undo") as HTMLButtonElement;
      const row = receipt(r.export.title, r.updated ? `Updated in ${where}` : `New ${to === "notion" ? "page" : "doc"} in ${where}`);
      // Under the row, so the title keeps its width on a phone.
      const acts = h("div", { style: "display:flex;gap:var(--space-xs);justify-content:flex-end;flex-wrap:wrap" }, open, r.updated ? null : undo);
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        try {
          await undoDocument(r.export.id);
          row.classList.add("is-undone");
          undo.replaceWith(h("span", { class: "change__state" }, icons.restore(), "Undone"));
          open.remove();
        } catch (e) {
          undo.disabled = false;
          showToast(errorText(e, "Couldn't undo that. Try again in a moment."), { icon: "restore" });
        }
      });
      go.remove();
      done.replaceChildren(row, acts);
    }, `Couldn't send it to ${PROVIDER_NAME[to]}`);
  });
  return el;
}
