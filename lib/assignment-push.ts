/**
 * A push when an assignment stops for the owner: a stage's question, approval
 * or plan that waits, a stage that didn't finish, and the finished assignment.
 * One per stop, keyed by the post (Team chat makes one post per wait, so a
 * stage that stops twice for the same wait sends one). Suggestions taken post
 * an update, which isn't a stop, and a wait already settled sends none.
 *
 * It goes through the same gate as a Team run's nudge (rule "team": the
 * owner's switch, mutes, quiet hours, the daily cap) and opens Team chat at
 * the post. No card of its own: Home's "something waits" card covers it, so
 * the nudge row is kept for the key and the cap and closed at once.
 */
import { clipLine } from "./assignment-lineup";
import type { PostKind, TeamPost } from "./assignment-types";
import { gate, type GateState, type HeldReason } from "./proactive/gate";
import type { Nudge } from "./proactive/types";
import { teamChatUrl } from "./proactive/urls";
import { CARD_HOURS, type DeliverDeps } from "./team-run";

/** The push's body, in the stage's assistant's voice. */
export const STOP_COPY: Partial<Record<PostKind, (title: string) => string>> = {
  question: (t) => `I need your answer on “${t}” before I go on.`,
  approval: (t) => `My stage of “${t}” is done. Have a look, then tap Approve.`,
  plan: (t) => `I have a change for “${t}” that waits for your approval.`,
  failed: (t) => `I didn't finish my stage of “${t}”. Tap Go to try it again.`,
  done: (t) => `“${t}” is finished. The document is ready.`,
};

type StopPost = Pick<TeamPost, "id" | "kind" | "who" | "assignment_id" | "assignment_title" | "waits_for" | "settled_at" | "created_at">;

/** The push for a post, or null when the post isn't a stop (an update, a handoff, a wait that's settled). Pure. */
export function stopNudge(post: StopPost): Nudge | null {
  const line = STOP_COPY[post.kind];
  if (!line || !post.assignment_id) return null;
  if (post.kind !== "done" && (!post.waits_for || post.settled_at)) return null;
  return {
    rule: "team",
    key: `team:post:${post.id}`,
    title: post.who ? `From ${post.who.name}` : "From your team",
    body: line(clipLine(post.assignment_title ?? "your assignment", 60)),
    why: [],
    context: "",
    prompt: "",
    about: [],
    actions: [],
    url: teamChatUrl(post.id),
    ...(post.who ? { assistant: { id: post.who.id, name: post.who.name, avatar: post.who.avatar } } : {}),
    expires_at: new Date(Date.parse(post.created_at) + CARD_HOURS * 3_600_000).toISOString(),
  };
}

/** Which of these posts push now, through the shared gate. Pure. */
export function stopsToPush(posts: StopPost[], state: GateState): { pass: Nudge[]; held: Array<{ nudge: Nudge; reason: HeldReason }> } {
  return gate(posts.map(stopNudge).filter((n): n is Nudge => !!n), state);
}

/** Send the pushes of recent stops, as deliverTeamNudges does for runs: quiet hours hold one for a later pass; off, muted or past the cap, it isn't sent. */
export async function deliverStopPushes(now: Date, tz: string, deps: DeliverDeps): Promise<{ sent: number; held: number }> {
  if (!deps.canPush) return { sent: 0, held: 0 };
  const [{ qRaw }, { getPost }] = await Promise.all([import("./db"), import("./team-posts")]);
  const rows = await qRaw<{ id: string }>(
    `SELECT id FROM team_posts WHERE assignment_id IS NOT NULL AND created_at > $1
        AND (kind = 'done' OR (kind IN ('question', 'approval', 'plan', 'failed') AND waits_for IS NOT NULL AND settled_at IS NULL)) ORDER BY id`,
    [new Date(now.getTime() - CARD_HOURS * 3_600_000).toISOString()],
  );
  if (!rows.length) return { sent: 0, held: 0 };
  const [{ loadProactivePrefs, loadMutes, madeOn, seenKeys, recordNudge, dismissNudge, markPushed }, { loadWorkingHours }, { zonedToday }] = await Promise.all([import("./proactive/store"), import("./scheduling"), import("./dates")]);
  const seen = await seenKeys(rows.map((r) => `team:post:${r.id}`));
  const fresh = rows.filter((r) => !seen.has(`team:post:${r.id}`));
  if (!fresh.length) return { sent: 0, held: 0 };
  const [prefs, mutes, hours] = await Promise.all([loadProactivePrefs(), loadMutes(), loadWorkingHours()]);
  const today = zonedToday(now, tz);
  let madeToday = await madeOn(today);
  let sent = 0;
  let held = 0;
  for (const row of fresh) {
    const post = await getPost(Number(row.id));
    if (!post) continue;
    const out = stopsToPush([post], { now, tz, prefs, working: { days: hours.days, start: hours.start, end: hours.end }, quiet: deps.quiet, mutes, madeToday, seen: new Set() });
    const n = out.pass[0];
    if (!n) {
      if (out.held[0]?.reason === "quiet") held++;
      continue;
    }
    const kept = await recordNudge(n, today, now);
    if (!kept) continue;
    await dismissNudge(kept.id);
    madeToday++;
    try {
      await deps.send({ title: n.title, body: n.body, url: n.url!, tag: `nudge:${n.key}` });
      await markPushed(kept.id);
      sent++;
    } catch (error) {
      console.error("Athena assignments: push failed", (error as Error).message?.slice(0, 120));
    }
  }
  return { sent, held };
}
