/**
 * Sample mode's shared items for the Add screen: made-up assistants, skills and flows behind made-up GitHub links,
 * one for each state the screen has (each reach tier, an account that isn't connected, a long one, one made for a
 * newer Athena). No real person, account or place.
 */
import type { CatalogueFile } from "../../../lib/catalogue-types";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const ITEMS: Record<string, { title: string; files: CatalogueFile[] }> = {
  "plant-care": {
    title: "Plant care, a flow that stays inside Athena",
    files: [
      {
        path: "flow.json",
        text: json({
          format: 1,
          name: "Plant care",
          version: "1.0.0",
          author: "sample-author",
          summary: "Every Saturday morning, adds “Water the plants” to your to-dos and tells you it's there.",
          trigger: { kind: "schedule", days: [6], time: "09:00" },
          steps: [
            { id: "s1", kind: "tool", tool: "add_todo", title: "Add “Water the plants”", input: { title: ["Water the plants"], context: [{ blank: "context" }] }, go: "auto", gives: [] },
            { id: "s2", kind: "notify", title: null, text: ["Watering is on your list for today."] },
          ],
          asks: [{ key: "context", question: "Which to-do context should it go in?", choices: ["Home", "Weekend", "No context"], fills: "text" }],
          needs: [],
        }),
      },
    ],
  },
  "rainy-walk": {
    title: "Rainy walk, a flow with a weather lookup",
    files: [
      {
        path: "flow.json",
        text: json({
          format: 1,
          name: "Rainy walk",
          version: "0.3.1",
          author: "sample-author",
          summary: "On weekday mornings, checks the forecast. If rain is likely, it drafts a note to your walking partner offering another time.",
          trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], time: "07:30" },
          steps: [
            { id: "s1", kind: "tool", tool: "weather", title: "Check the forecast", input: { when: ["today"] }, go: "auto", gives: [{ key: "rain", label: "chance of rain", kind: "number" }] },
            {
              id: "s2",
              kind: "check",
              title: null,
              condition: { left: { from: "s1", key: "rain" }, op: "more_than", right: 60 },
              yes: [
                { id: "s3", kind: "tool", tool: "draft_message", title: "Offer another time", input: { to: [{ blank: "walker" }], body: ["Rain's due this morning. Shall we walk at lunch instead?"] }, go: "ask", gives: [] },
              ],
              no: [{ id: "s4", kind: "notify", title: null, text: ["Dry enough for the walk: ", { from: "s1", key: "rain" }, "% chance of rain."] }],
            },
          ],
          asks: [{ key: "walker", question: "Who do you walk with?", choices: [], fills: "person" }],
          needs: [],
        }),
      },
    ],
  },
  "price-check": {
    title: "Price check, a flow that searches the web",
    files: [
      {
        path: "flow.json",
        text: json({
          format: 1,
          name: "Price check",
          author: "sample-author",
          summary: "When an order confirmation arrives, looks for the same thing cheaper online and tells you what it found.",
          trigger: { kind: "event", event: { source: "collected", connector: "gmail", kind: "order" } },
          steps: [
            { id: "s1", kind: "think", title: "Look for it cheaper", task: ["Search for ", { from: "trigger", key: "item" }, " and find the lowest price from a shop in the UK."], web: true, gives: [{ key: "best", label: "best price", kind: "money" }] },
            { id: "s2", kind: "notify", title: null, text: ["Best price found: ", { from: "s1", key: "best" }] },
          ],
          asks: [],
          needs: ["gmail"],
          web: true,
        }),
      },
    ],
  },
  tidy: {
    title: "Tidy, an assistant that needs Linear",
    files: [
      {
        path: "assistant.json",
        text: json({
          format: 1,
          name: "Tidy",
          job: "Turns Linear issues assigned to you into to-dos",
          version: "1.1.0",
          author: "sample-author",
          summary: "Adds a to-do for each Linear issue assigned to you, in the context you choose, with the issue's own due date.",
          instructions: "When a Linear issue is assigned to me, add a to-do with its title and link. Leave the due date empty unless the issue has one.",
          triggers: [{ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } }],
          asks: [{ question: "Which context should work to-dos go in?", choices: ["Work", "No context"] }],
          needs: ["linear"],
          would_like: ["add_todo", "complete_todo", "archive_or_restore"],
          web: false,
          personality: { tone: "crisp", traits: ["tidy", "quick"], pronoun: "they", greeting: "Ready when you are." },
        }),
      },
      { path: "SKILL.md", text: "---\nname: tidy\ndescription: Tidy's skill: how it turns issues into to-dos.\n---\n\n1. Read the issue: its title, link and due date.\n2. If there's already a to-do for it, leave it.\n3. Add a to-do with the title and link, in the context your owner chose.\n4. Say in one line what you added.\n" },
    ],
  },
  scout: {
    title: "Scout, an assistant that asks for the web and Slack",
    files: [
      {
        path: "assistant.json",
        text: json({
          format: 1,
          name: "Scout",
          job: "Reads what your team says about a topic and what's new on the web, then writes you a short brief",
          version: "2.0.0",
          author: "sample-author",
          based_on: "https://github.com/sample-author/athena-items/tree/main/assistants/reader",
          summary: "Each Monday it reads the week's Slack threads on the topics you give it and searches the web for news on each, then writes a one-page brief with links.",
          instructions: [
            "Every Monday at 8, write me a brief on the topics I gave you.",
            "",
            "1. For each topic, read the last week's Slack threads that mention it. Note who asked what, and anything still open.",
            "2. Search the web for news on each topic from the last seven days. Prefer the source over a write-up of it. Skip anything behind a paywall.",
            "3. Write one short section per topic: what changed, what people are asking, and one thing worth reading, with its link.",
            "4. Finish with anything that needs a decision from me this week.",
            "",
            "Keep the whole brief under a page. Don't quote anyone at length; say what they said in a sentence. If a topic had nothing new, say so in one line rather than padding it out.",
            "",
            "When you're not sure whether something is news, leave it out. When a thread is long, read the start and the last ten messages. Never post in Slack or reply to anyone: the brief is for me only.",
          ].join("\n"),
          triggers: [{ kind: "schedule", days: [1], time: "08:00" }],
          asks: [
            { question: "Which topics should it follow?", choices: [] },
            { question: "How long should the brief be?", choices: ["A few lines", "About a page"] },
          ],
          needs: ["slack"],
          would_like: ["save_note", "send_email"],
          web: true,
        }),
      },
      {
        path: "SKILL.md",
        text: "---\nname: scout\ndescription: Scout's skill: how it writes the Monday brief.\n---\n\n# Monday brief\n\n## Reading\n\n- Start with threads that have the most replies.\n- A thread with a question and no answer goes under \"Still open\".\n\n## Searching\n\n- Two searches per topic at most.\n- Prefer the organisation's own announcement.\n\n## Writing\n\n- One heading per topic.\n- Each section: two or three sentences, then one link.\n- Plain words. No jargon the owner didn't use first.\n",
      },
      { path: "reference/sources.md", text: "# Sources worth checking\n\n- The topic's own project page\n- Release notes\n- A standards body's news page\n" },
      { path: "scripts/summarise.py", text: "print('not run')\n" },
    ],
  },
  "packing-list": {
    title: "Packing list, a skill",
    files: [
      {
        path: "SKILL.md",
        text: "---\nname: packing-list\ndescription: Use when I ask what to pack for a trip.\n---\n\n# Packing list\n\n1. Look at the trip: where, how long, and what's planned each day.\n2. Check the forecast for those days if you can.\n3. List what to pack, grouped: clothes, wash bag, documents, tech, anything for the plans.\n4. Mark anything I usually forget, from reference/forgotten.md.\n5. Keep it to one screen.\n",
      },
      { path: "reference/forgotten.md", text: "# Usually forgotten\n\n- Phone charger\n- Plug adaptor\n- Reading glasses\n" },
    ],
  },
  "newer-flow": {
    title: "A flow made for a newer Athena",
    files: [{ path: "flow.json", text: json({ format: 2, name: "Morning digest", summary: "Made for a newer Athena.", trigger: { kind: "manual" }, steps: [] }) }],
  },
};

const BASE = "https://github.com/sample-author/athena-items/tree/main";

/** The made-up links sample mode offers, with a line on each. */
export const SAMPLE_LINKS: ReadonlyArray<{ link: string; title: string }> = Object.entries(ITEMS).map(([slug, v]) => ({ link: `${BASE}/${slug}`, title: v.title }));

/** A made-up item's files for a sample link (by its last folder name), or null. */
export function sampleLinkFiles(link: string): Array<{ path: string; text: string }> | null {
  let slug = "";
  try {
    slug = new URL(link).pathname.split("/").filter(Boolean).filter((p) => !/\.(json|md)$/i.test(p)).pop() ?? "";
  } catch {
    return null;
  }
  const item = ITEMS[slug];
  return item ? item.files.map((f) => ({ path: `${slug}/${f.path}`, text: f.text })) : null;
}
