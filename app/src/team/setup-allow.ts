/**
 * Team: what an assistant can do alone, in
 * plain words. `allow` holds assistant tool names (lib/assistant.ts); the
 * owner only ever sees the sentence.
 */

export interface AllowOption {
  tool: string;
  /** The switch's label: "Add to-dos". */
  label: string;
  /** One quiet line under it. */
  detail: string;
}

export const ALLOW_OPTIONS: readonly AllowOption[] = [
  { tool: "add_todo", label: "Add to-dos", detail: "Puts new to-dos on your list" },
  { tool: "complete_todo", label: "Tick off to-dos", detail: "Marks to-dos as done" },
  { tool: "add_reminder", label: "Set reminders", detail: "Adds reminders with a time" },
  { tool: "save_note", label: "Write notes", detail: "Saves new notes in your library" },
  { tool: "add_to_list", label: "Add to your lists", detail: "Gift ideas, shopping, packing and other lists" },
  { tool: "add_to_watch_read", label: "Add to watch and read", detail: "Books, films and shows" },
  { tool: "update_watch_read", label: "Update watch and read", detail: "Marks things started or finished" },
  { tool: "add_person", label: "Add people", detail: "New people in your contacts" },
  { tool: "log_catch_up", label: "Log catch-ups", detail: "Records when you met someone" },
  { tool: "remember", label: "Remember things", detail: "Keeps facts about you and the people you know" },
  { tool: "save_purchase", label: "Log purchases", detail: "Adds orders and receipts" },
  { tool: "save_trip", label: "Save trips", detail: "Adds trips and their plans" },
  { tool: "save_booking", label: "Save bookings", detail: "Adds flights, trains and stays to a trip" },
];

export function allowOption(tool: string): AllowOption {
  return ALLOW_OPTIONS.find((o) => o.tool === tool) ?? { tool, label: tool.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), detail: "" };
}

const HINTS: Array<[RegExp, string]> = [
  [/\bto-?dos?\b|\btasks?\b/i, "add_todo"],
  [/\b(tick|complete|close|finish)\b/i, "complete_todo"],
  [/\bremind/i, "add_reminder"],
  [/\b(notes?|summ(ary|arise|arize|s up)|write up|digest|recap)\b/i, "save_note"],
  [/\b(shopping|packing|lists?|gifts?|prices?)\b/i, "add_to_list"],
  [/\b(books?|films?|movies?|shows?|watch|read(ing)?)\b/i, "add_to_watch_read"],
  [/\b(catch[- ]?ups?|met|meeting)\b/i, "log_catch_up"],
  [/\b(orders?|receipts?|purchases?)\b/i, "save_purchase"],
  [/\b(trips?|flights?|travel|bookings?)\b/i, "save_booking"],
];

/**
 * The switches setup offers: the ones the draft proposes, then any the job's
 * words point at, and nothing else. A job that points at nothing gets the
 * three most common.
 */
export function allowFor(job: string, proposed: readonly string[] = []): string[] {
  const out = [...proposed];
  for (const [re, tool] of HINTS) if (re.test(job) && !out.includes(tool)) out.push(tool);
  if (!out.length) out.push("add_todo", "save_note", "add_reminder");
  return out.slice(0, 5);
}

/** "Asks you first" when empty; otherwise "Can add to-dos and set reminders without asking". */
export function allowSummary(allow: readonly string[]): string {
  if (!allow.length) return "Asks you first";
  const words = allow.map((t) => allowOption(t).label.toLowerCase());
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `Can ${list} without asking`;
}
