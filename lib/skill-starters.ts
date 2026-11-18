/**
 * The three skills every Athena starts with, off until the owner turns one
 * on (lib/skills-store.ts adds them once). Ordinary SKILL.md text: the owner
 * can edit, download or delete them like any other.
 */

export interface StarterSkill {
  key: string;
  text: string;
}

export const STARTER_SKILLS: StarterSkill[] = [
  {
    key: "weekly-review",
    text: `---
name: weekly-review
description: Use when the owner asks for a weekly review, a look back at their week, or what to carry into next week.
---

# Weekly review

1. Read the week from Monday to today: days (what they did), habits, health (sleep and steps against the week before), goals, and to-dos done and still open.
2. Answer in three parts, a sentence or two each:
   - What happened: the things they'd want to remember.
   - What slipped: to-dos past their date, habits missed more than twice, goals that haven't moved.
   - Next week: what's on the calendar that needs getting ready for.
3. Plain words, no scores or ratings. Leave out anything with nothing to say.
4. If they ask to move or add something, make it a change. It waits for their Go like any other.
`,
  },
  {
    key: "plan-meals",
    text: `---
name: plan-meals
description: Use when the owner asks to plan meals or dinners for the week, or what to cook on which night.
---

# Plan meals for the week

1. Look at the evenings from today to Sunday in their day and calendar. An evening with something on after 17:30, or travel, needs something quick (30 minutes or less). A night away needs nothing.
2. Find their own recipes with find_recipes. Use only those: never make up a recipe.
3. Pick one dinner a night. Nothing twice in the week, and nothing they cooked in the last few days.
4. Answer with each night and its recipe, and why for the quick ones ("book club at 19:00").
5. Say that the Recipes page has the week's plan and the shopping list. If they want something added to a list, make it a change for their Go.
`,
  },
  {
    key: "meeting-prep",
    text: `---
name: meeting-prep
description: Use when the owner asks to prep for, get ready for, or be briefed on a meeting or call.
---

# Prep me for a meeting

1. Find the meeting: today's calendar first, then the calendar account. If more than one could be meant, ask which.
2. For each person going who's in Athena, read person_details: the last catch-up, open to-dos both ways and decisions.
3. Search notes, calls and email from the last 30 days for the meeting's subject.
4. Answer in a few sentences: who's going and how they know them, what's still open with each, what was decided last time, and one question worth asking.
5. Cite each thing. If Athena has nothing on someone, say so rather than guess.
`,
  },
];
