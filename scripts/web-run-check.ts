/**
 * A live price check through a web-enabled Team run (docs/team-notes/web-runs.md, "Live check"): the same loop,
 * budget, rule and region a scheduled run uses, against the real model and the real web. No database needed.
 *
 *   ANTHROPIC_API_KEY=… npx tsx scripts/web-run-check.ts "LEGO Technic Ferrari Daytona SP3 42143" "United Kingdom, GBP, English" Leeds
 *
 * Or with Netlify's AI Gateway, inside `netlify dev` (it sets ANTHROPIC_BASE_URL and the key). Prints each step,
 * the reply, its sources, and whether the price came from a page web_fetch read.
 */
import { runAsk } from "../lib/answer";
import { readRegion } from "../lib/region";
import { personaFor, webTurnFor } from "../lib/team-chat";
import type { TeamAssistant } from "../lib/team-types";

const [item = "LEGO Technic Ferrari Daytona SP3 42143", where = "United Kingdom, GBP, English", town = "Leeds"] = process.argv.slice(2);

const pip: TeamAssistant = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Pip",
  job: "Checks prices for my gift ideas",
  instructions: "Find the current price at a shop in the owner's country, from the shop's own page.",
  personality: { tone: "calm", traits: [], pronoun: "they", greeting: "" },
  avatar: {} as TeamAssistant["avatar"],
  allow: [],
  web: true,
  paused: false,
  routine_id: null,
  memory: { summary: "", facts: [] },
  memory_updated_at: null,
  last_run_at: null,
  triggers: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const region = readRegion(where, town);
const started = Date.now();
const reply = await runAsk(
  `Every Friday at 17:00: do your job.\n\nThe saved item this run is about (its title and link may go in a search, and you may open the link):\n<item>\nTitle: ${item}\n</item>`,
  {
    sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) },
    web: async () => true,
    region: async () => (region.country ? region : null),
    mentions: async () => ({ found: [], missing: [] }),
  },
  {
    tz: "Europe/London",
    persona: personaFor(pip, { mode: "run" }),
    plan: "propose",
    log: false,
    webTurn: webTurnFor(pip, { mode: "run" }),
    maxTurns: 10,
    budgetMs: 3 * 60_000,
    onStep: (s) => {
      if (s.done && !s.dropped) console.log(`  · ${s.text}`);
    },
  },
);
const pages = reply.sources.filter((s) => (s.kind as string) === "web");
console.log(`\n${reply.text}\n`);
for (const s of reply.sources) console.log(`  [${s.n}] ${s.title} ${s.url ?? ""}`);
console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s · placed: ${region.country ? `${region.city ?? ""} ${region.country} ${region.currency}` : "nowhere"} · cited pages: ${pages.length}`);
process.exitCode = pages.length ? 0 : 1;
