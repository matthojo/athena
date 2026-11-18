/**
 * What the model's team_draft call has handed back, for lib/team-draft.test.ts:
 * a clean draft, one that overreaches (tools it shouldn't have, a long job,
 * a bad trigger), and junk.
 */

/** "When I save a gift idea, find a good price". */
export const GIFT_PRICES = {
  name: "Muse",
  job: "Finds good prices for gift ideas",
  instructions: "When a gift idea is saved, look for the best price from a shop the owner trusts and add a to-do to buy it if it's a good deal.",
  triggers: [{ kind: "event", event: { source: "saved", savedAction: "Gift-Idea" } }],
  allow: ["add_todo"],
};

/** "Every Friday at 5, sum up my week": no name, so the app names it. */
export const WEEKLY_SUMMARY = {
  name: null,
  job: "Sums up your week every Friday",
  instructions: "Read the week's days, notes and finished to-dos, and save a short note summing it up.",
  triggers: [{ kind: "schedule", days: [5], time: "17:00" }],
  allow: ["save_note"],
};

/** Overreaching: a long job, tools that aren't real or can't be allowed, triggers that don't hold up, a name with markup. */
export const OVERREACH = {
  name: "<b>Linear Larry</b> the Issue-Watcher Extraordinaire of All Tickets",
  job: "Watches Linear for issues assigned to the owner and turns each one into a to-do with the right area and a due date.",
  instructions: "Add a to-do for each issue.",
  triggers: [
    { kind: "event", event: { source: "collected", connector: "Linear", kind: "Issue", match: "assigned" } },
    { kind: "schedule", days: [], time: "09:00" },
    { kind: "schedule", days: [1, 2], time: "25:99" },
    { kind: "event" },
    { kind: "sometimes" },
  ],
  allow: ["add_todo", "delete_everything", "draft_message", "find_notes", "add_todo"],
};

export const JUNK = [null, "a string", { job: 42 }, { name: "x" }, { job: "   " }];
