/**
 * Team chat, for the app (/api/team/chat on the
 * server): one channel for everything that waits for the owner. Sample
 * mode makes it from the sample assignments and the sample team's runs
 * (db/sample-assignments.ts), so it agrees with every other Team screen.
 */
import { isSampleMode, request } from "./api";
import { assignmentsChanged, onAssignmentsChange } from "./assignments";
import { listActivity, listTeam, onTeamChange } from "./team";
import { onThreadsChange } from "./ask-threads";
import { askedPosts, SAMPLE_ASKED_THREAD, sampleAssignments, sampleChat, standingPosts } from "./sample-assignments";
import { sampleAskedThread } from "./sample-team-detail";
import { SAMPLE_TEAM_IDS } from "./sample-team";
import { planWaits } from "../lib/team-report";
import { planCounts, waitsFrom } from "../team/page-pulse";
import { dismissRun, isDismissed, onDismissChange } from "../team/page-dismiss";
import type { TeamChat, TeamPost } from "../../../lib/assignment-types";

export type { TeamChat, TeamPost };

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
let wired = false;

/**
 * Something was posted or settled. The chat also follows whatever can
 * settle a post from elsewhere: an assignment moving on, a run, a Go in Ask,
 * a dismissal.
 */
export function onChatChange(fn: () => void): () => void {
  if (!wired) {
    wired = true;
    onAssignmentsChange(changed);
    onTeamChange(changed);
    onThreadsChange(changed);
    onDismissChange(changed);
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The channel, oldest first, and what waits. `before`: the id the last page gave, for older posts. */
export async function getChat(before?: number | null): Promise<TeamChat> {
  if (isSampleMode()) {
    const [team, runs] = await Promise.all([listTeam(), listActivity(50)]);
    const waits = waitsFrom(await planCounts(runs));
    // Dot's "@Name" reply keeps its plan in a conversation on this device; a Go there settles it.
    const dot = team.find((t) => t.id === SAMPLE_TEAM_IDS.dot);
    const asked = dot ? await sampleAskedThread(SAMPLE_ASKED_THREAD, dot.id) : null;
    const said = asked ? askedPosts(dot, asked.created_at, !planWaits(asked.messages)) : [];
    return sampleChat([...sampleAssignments().posts(), ...said], standingPosts(team, runs, waits, isDismissed), before);
  }
  const r = await request<TeamChat>(`/team/chat${before == null ? "" : `?before=${before}`}`);
  return { posts: r.posts ?? [], waiting: r.waiting ?? [], before: r.before ?? null };
}

/**
 * Dismiss a run that didn't finish (`waits_for: "dismiss"`): it leaves the
 * strip and the count. The Team page's own list forgets it too (on this
 * device). Sample mode only does that part.
 */
export async function dismissPost(p: Pick<TeamPost, "id" | "run_id">): Promise<void> {
  if (!isSampleMode()) await request(`/team/chat/${p.id}/dismiss`, { method: "POST" });
  if (p.run_id) dismissRun(p.run_id);
  changed();
}

/**
 * Type in the channel. In an assignment's thread it goes to the stage that
 * waits; "@Name" goes to that assistant; anything else goes to Ask. What
 * was posted comes back when the server sends it; the chat looks again
 * either way.
 */
export async function say(text: string, assignmentId?: string | null): Promise<TeamPost[]> {
  let made: TeamPost[];
  if (isSampleMode()) made = sampleAssignments().say(text, assignmentId, await listTeam());
  else {
    const r = await request<{ posts?: TeamPost[]; post?: TeamPost } | null>("/team/chat", { method: "POST", body: JSON.stringify({ text, ...(assignmentId ? { assignment_id: assignmentId } : {}) }) });
    made = r?.posts ?? (r?.post ? [r.post] : []);
  }
  // Typing can answer a stage, so the assignments look again too (which tells the chat).
  assignmentsChanged();
  return made;
}
