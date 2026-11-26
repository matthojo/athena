/**
 * What waits for you: one per
 * post that waits, so the count is the length of the chat's `waiting` list.
 * A plan is 1 whatever it holds, a question 1, an approval 1, a run that
 * didn't finish 1. One count for the sidebar, the Team page, Home, phone
 * Home's Team button and Team chat's strip. Who is working still comes from
 * the team's pulse (team/page-pulse.ts), with guests at work added.
 */
import { listAssignments } from "../db/assignments";
import { getChat, onChatChange } from "../db/team-chat";
import { watchTeamPulse, type TeamPulse } from "./page-pulse";
import { waitingPosts } from "./assign-words";
import type { Assignment } from "../../../lib/assignment-types";

/** The pulse's names with guests at work added. */
export function workingWith(p: Pick<TeamPulse, "working">, list: readonly Assignment[]): string[] {
  const guests = list.filter((a) => a.status === "running").flatMap((a) => a.stages.filter((s) => s.status === "running" && s.who.guest).map((s) => s.who.name));
  return [...p.working, ...guests.filter((n) => !p.working.includes(n))];
}

/** As watchTeamPulse, with the chat's count. While a stage works it looks again every few seconds. */
export function watchWaiting(fn: (p: TeamPulse) => void): () => void {
  let pulse: TeamPulse = { working: [], waiting: 0 };
  let list: Assignment[] = [];
  let waits: number | null = null;
  let last = "";
  let timer = 0;
  let stopped = false;
  const tell = () => {
    // An older server, or offline, has no chat: the pulse alone.
    const p: TeamPulse = { working: workingWith(pulse, list), waiting: waits ?? pulse.waiting };
    const key = JSON.stringify(p);
    if (key === last) return;
    last = key;
    fn(p);
  };
  const look = async () => {
    window.clearTimeout(timer);
    const [chat, asg] = await Promise.all([getChat().catch(() => null), listAssignments().catch(() => null)]);
    if (stopped) return;
    waits = chat ? waitingPosts(chat).length : null;
    if (asg) list = asg;
    tell();
    if (list.some((a) => a.status === "running") && document.visibilityState !== "hidden") timer = window.setTimeout(look, 4000);
  };
  const stopPulse = watchTeamPulse((p) => {
    pulse = p;
    tell();
    void look();
  });
  // The chat hears of anything that can settle a post: an assignment, a run, a Go in Ask, a dismissal.
  const off = onChatChange(() => void look());
  void look();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    stopPulse();
    off();
  };
}
