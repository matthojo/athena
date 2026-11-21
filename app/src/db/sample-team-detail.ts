/**
 * Sample mode's conversations for the team's runs (docs/team.md): every
 * sample run keeps one, as a real run does, so opening a run on the Team
 * page, an assistant's page or Home's card opens the same conversation in
 * Ask. Dot's morning run keeps its plan there: a Go on any screen answers
 * it, and every screen's count drops (lib/team-report.ts runWaits).
 *
 * The runs themselves are db/sample-team.ts `sampleRuns`: one list for
 * every screen. This file adds what a Run now says while it works.
 */
import type { TeamRun } from "../../../lib/team-types";
import type { AskThread, AssistantChange } from "../types";
import { SAMPLE_TEAM_IDS, sampleRuns, sampleRunThreadId } from "./sample-team";
import { getThread, saveThread } from "./ask-threads";

export { sampleRunThreadId };

/** One assistant's runs as its page shows them: the same list the Team page and Home read. */
export const sampleRunHistory = (assistantId: string): TeamRun[] => sampleRuns(assistantId);

const STEPS: Record<string, string[]> = {
  [SAMPLE_TEAM_IDS.penny]: ["Looking at your gift ideas", "Searching the web for Lego Technic prices", "Reading smyths.co.uk", "Reading johnlewis.com"],
  [SAMPLE_TEAM_IDS.dot]: ["Reading new Linear issues", "Checking your to-dos"],
  [SAMPLE_TEAM_IDS.wren]: ["Reading your week", "Writing it up"],
};

/** Penny with her web switch off: she can only go on the prices you saved. */
const OFFLINE: Record<string, string[]> = {
  [SAMPLE_TEAM_IDS.penny]: ["Looking at your gift ideas", "Checking the prices you saved"],
};

/** What a sample Run now says it's doing, this far in. One that may look things up online says what it searched and read. */
export function sampleRunStep(assistantId: string, ageMs: number, web = true): string {
  const steps = (!web && OFFLINE[assistantId]) || STEPS[assistantId] || ["Looking at what's new", "Looking through your notes"];
  return steps[Math.min(steps.length - 1, Math.floor(ageMs / 2200))];
}

const DONE: Record<string, string> = {
  [SAMPLE_TEAM_IDS.penny]: "Checked your 6 gift ideas. Nothing has dropped in price since Tuesday.",
  [SAMPLE_TEAM_IDS.dot]: "No new issues since this morning, so nothing to add.",
  [SAMPLE_TEAM_IDS.wren]: "Your week so far: 7 to-dos done, 2 meetings, and nothing has slipped yet.",
};

/** What a sample Run now finds. */
export const sampleRunNowSummary = (assistantId: string) => DONE[assistantId] ?? "Nothing to do this time.";

const changeId = (n: number) => `5a3e0000-0000-4000-8000-0000000e09${String(n).padStart(2, "0")}`;

const todo = (n: number, title: string): AssistantChange => ({
  kind: "commitment",
  id: changeId(40 + n),
  action: "created",
  title,
  detail: "To do · Work",
  label: `${title}: To do`,
  open: null,
  undo: { op: "sample" },
});

/** What a few runs said in full, beyond their summary: Penny's Lego Ferrari and Dot's three issues, with Dot's plan. */
const REPLIES: Record<string, () => Partial<Extract<AskThread["messages"][number], { role: "assistant" }>>> = {
  // Penny's Lego Technic Ferrari Daytona, this afternoon.
  "5a3e0000-0000-4000-8000-0000000e0201": () => ({
    reply: {
      text: "Found the Lego Ferrari for £34 at Smyths, £8 under the price when you saved it. You bought from them last Christmas, so I'd get it there. I've put the price and the link on Rowan's gift idea.",
      changes: [{ kind: "record", id: changeId(31), action: "updated", title: "Lego Technic Ferrari Daytona", detail: "£34 at Smyths", label: "Lego Technic Ferrari Daytona: £34 at Smyths", open: null, undo: { op: "sample" } }],
      choices: [],
    },
    steps: ["Looked at your gift ideas", "Searched the web for Lego Technic Ferrari Daytona", "Read smyths.co.uk and johnlewis.com", "Put the price on the gift idea"],
  }),
  // Dot's three issues this morning: two to-dos, and one left for your Go.
  "5a3e0000-0000-4000-8000-0000000e0204": () => ({
    reply: {
      text: "Three Linear issues came in. I added two as to-dos in Work. “Plan the Q3 offsite” reads like more than a to-do, so I've left it here for you to decide.",
      changes: [todo(1, "Fix the sync banner on iPad"), todo(2, "Review the export spec")],
      choices: [],
      plan: { id: changeId(51), source: "routine", proposed: true, steps: [{ label: "Add a to-do: Plan the Q3 offsite", tool: "add_todo" }] },
    },
    steps: ["Read 3 new issues", "Added 2 to-dos"],
  }),
};

/** A sample run's conversation, as Ask would have kept it: what set it off, then the reply. */
export function sampleRunThread(run: TeamRun): AskThread {
  const at = run.finished_at ?? run.started_at;
  const more = REPLIES[run.id]?.() ?? {};
  return {
    id: run.thread_id ?? sampleRunThreadId(run.id),
    title: run.label?.replace(/^New (?:gift idea|issue): “(.+)”$/, "$1") ?? "",
    assistant_id: run.assistant_id,
    created_at: run.started_at,
    updated_at: at,
    messages: [
      { role: "me", text: run.label || "Run now", at: run.started_at, run_line: true },
      { role: "assistant", at, request: [], reply: { text: run.summary || "Nothing to do this time.", changes: [], choices: [] }, error: null, undone: [], answered: true, ...more },
    ],
  } as AskThread;
}

/**
 * The conversation behind sample mode's "@Dot" reply in Team chat, with the
 * plan its card draws. Written once; a Go since is kept.
 */
export async function sampleAskedThread(id: string, assistantId: string): Promise<AskThread | null> {
  const kept = await getThread(id).catch(() => null);
  if (kept && Date.now() - Date.parse(kept.created_at) < STALE_MS) return kept;
  const at = new Date(Date.now() - 50 * 60_000).toISOString();
  const thread = {
    id,
    title: "Book the offsite venue",
    assistant_id: assistantId,
    created_at: at,
    updated_at: at,
    messages: [
      { role: "me", text: "Put booking the offsite venue on my list", at },
      { role: "assistant", at, request: [], reply: { text: "I can add that. Here's the to-do I'd make.", changes: [], choices: [], plan: { id: changeId(52), source: "routine", proposed: true, steps: [{ label: "Add a to-do: Book the offsite venue", tool: "add_todo" }] } }, error: null, undone: [], answered: true },
    ],
  } as AskThread;
  return saveThread(thread).then(() => thread, () => null);
}

/** A stored conversation from an earlier visit's sample day: the day has moved on, so it's written afresh. */
const STALE_MS = 12 * 3_600_000;

/**
 * Put each finished run's conversation on this device, once: a Go done since
 * is kept, so the count stays down. One left from an earlier day is replaced.
 */
export async function seedSampleThreads(runs: readonly TeamRun[]): Promise<void> {
  await Promise.all(
    runs
      .filter((r) => r.thread_id && (r.status === "done" || r.status === "failed"))
      .map(async (r) => {
        const kept = await getThread(r.thread_id!).catch(() => null);
        if (kept && Math.abs(Date.parse(kept.created_at) - Date.parse(r.started_at)) < STALE_MS) return;
        await saveThread(sampleRunThread(r));
      })
  ).catch(() => undefined);
}
