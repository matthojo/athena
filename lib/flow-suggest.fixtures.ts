/**
 * Made-up habits for lib/flow-suggest.test.ts and the routes' test: invented
 * shops, hotels and chores, nobody real. "Now" is Friday 20 November 2026,
 * noon in London.
 */
import type { AskChange, CollectedItem, OwnerReminder, OwnerTodo, SavedFiling, SuggestSignals } from "./flow-suggest";

export const NOW = new Date("2026-11-20T12:00:00Z");
export const TZ = "Europe/London";

const day = (n: number, hhmm = "09:00") => {
  const d = new Date(NOW.getTime() - n * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hhmm}:00.000Z`;
};
const plusHours = (at: string, h: number) => new Date(Date.parse(at) + h * 3_600_000).toISOString();

export function empty(): SuggestSignals {
  return { collected: [], collectedDays: { delivery: 30, booking: 7, appointment: 7, deadline: 7, renewal: 7 }, reminders: [], todos: [], activity: [], saved: [] };
}

let seq = 0;
const id = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;

export function item(kind: string, title: string, at: string): CollectedItem {
  return { id: id("item"), kind, title, times: [at] };
}

export function reminder(text: string, created_at: string, remind_at: string, repeat = "none", done = false): OwnerReminder {
  return { id: id("rem"), text, created_at, remind_at, repeat, done };
}

export function todo(title: string, created_at: string, due_on: string | null = null): OwnerTodo {
  return { id: id("todo"), title, created_at, due_on };
}

export function listAdd(list: string, line: string, at: string, created = false): AskChange {
  return { at, state: "done", change: { kind: "note", action: created ? "created" : "updated", title: list, detail: created ? `New list · ${line}` : `Added ${line}` } };
}

export function saved(thing: string | null, saved_at: string, filedAfterHours: number | null, action: string | null): SavedFiling {
  return { id: id("saved"), thing, saved_at, filed_at: filedAfterHours == null ? null : plusHours(saved_at, filedAfterHours), action };
}

/** Five delivery emails this month; after four the owner set a reminder for the day it comes. */
export function deliveryHabit(followed = 4, total = 5): SuggestSignals {
  const s = empty();
  const shops = ["Hollowbrook Books", "Parcelwise Garden Supplies", "Fernlea Kitchenware", "Quillstone Stationers", "Marrowby Outdoor", "Tidewell Toys"];
  for (let i = 0; i < total; i++) {
    const at = day(3 + i * 5, "08:30");
    s.collected.push(item("delivery", `Your order from ${shops[i]} is on its way`, at));
    if (i < followed) {
      const words = i % 2 ? `${shops[i].split(" ")[0]} parcel` : "Parcel arriving";
      s.reminders.push(reminder(words, plusHours(at, 2), day(1 + i * 5, "07:45")));
    }
  }
  return s;
}

/** Put the bins out, set by hand for each Tuesday evening, four weeks running. */
export function binsHabit(): SuggestSignals {
  const s = empty();
  // Tuesdays before 20 Nov 2026: 17, 10, 3 Nov and 27 Oct. 19:00 in London is 19:00 GMT in November.
  for (const [made, fires] of [
    ["2026-11-16T20:10:00.000Z", "2026-11-17T19:00:00.000Z"],
    ["2026-11-09T21:00:00.000Z", "2026-11-10T19:05:00.000Z"],
    ["2026-11-02T18:30:00.000Z", "2026-11-03T18:55:00.000Z"],
    ["2026-10-26T19:45:00.000Z", "2026-10-27T19:00:00.000Z"],
  ])
    s.reminders.push(reminder(made === "2026-11-16T20:10:00.000Z" ? "Put the bins out" : "put the bins out!", made, fires));
  return s;
}

export const at = { day, plusHours };
