/**
 * Team chat (docs/team.md "Team chat", lib/team-posts.ts):
 *
 *   GET  /api/team/chat?before=<id>&limit=<n>  → TeamChat: a page of posts and everything that waits, oldest first
 *   POST /api/team/chat { text, assignment_id? } → { posts }: the owner's `said` post and any `reply` (201)
 *   POST /api/team/chat/<id>/dismiss → { post }: a run that didn't finish leaves the strip (409 for any other post)
 *
 * What's typed goes to one place, decided here in plain code, never by a model:
 *   1. in an assignment's thread, "continue and use all suggested routes" (and close phrasings) takes the suggestions from here on;
 *   2. "@Name" is a chat turn as that assistant, answered in the channel as a `reply` (one that proposes changes
 *      keeps its conversation: the reply carries its `thread_id` and waits for Go);
 *   3. in a thread with a stage waiting, the text is that stage's answer;
 *   4. anything else goes to Ask, the lead, answered as a `reply`.
 *
 * Assistants never read the channel: a chat turn is given the owner's
 * message and nothing posted here, and a stage gets its answer from the
 * runner. The assignments side is reached through ChatDesk, a port the
 * integrator fills; until then it answers "not available yet".
 *
 * Behind the same bearer token as the rest of the API.
 */
import { AthenaInputError, q, qRaw } from "../../lib/db";
import { getAssistant } from "../../lib/team";
import { MAX_POST, dismissPost, listChat, postToTeam } from "../../lib/team-posts";
import type { TeamChat, TeamPost } from "../../lib/assignment-types";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The assignments side, as Team chat needs it (lib/assignment*.ts fills it at integration). */
export interface ChatDesk {
  /** The owner's reply to the stage that waits: its answer, or a note. */
  answerStage(assignmentId: string, text: string): Promise<void>;
  /** Take the suggested answers: for this stop, or (`fromHere`) from here on. */
  useSuggestions(assignmentId: string, fromHere: boolean): Promise<void>;
  /** The id of the stage that waits for the owner, or null. */
  waitingStage(assignmentId: string): Promise<string | null>;
}

export const DESK_NOT_YET = "Assignments aren't available yet.";

/** Until the assignments side is wired: nothing waits, and nothing can be answered. */
export const NO_DESK: ChatDesk = {
  answerStage: async () => {
    throw new AthenaInputError(DESK_NOT_YET);
  },
  useSuggestions: async () => {
    throw new AthenaInputError(DESK_NOT_YET);
  },
  waitingStage: async () => null,
};

export interface ChatDeps {
  desk?: ChatDesk;
  /** Ask, as the lead (lib/answer.ts runAsk): its reply's words. */
  ask: (text: string) => Promise<string>;
  /** One chat turn as that assistant (lib/team-chat.ts runAssistantTurn, mode chat): its reply's words, and the conversation kept when it left a plan for Go. */
  turn: (assistantId: string, text: string) => Promise<{ text: string; thread_id?: string | null }>;
  /** Who "@Name" can reach: the standing team, and in a thread its guests. */
  team?: (assignmentId: string | null) => Promise<Array<{ id: string; name: string }>>;
}

export const NOT_DISMISSED = "Only a run that didn't finish can be dismissed.";
export const CHAT_FAILED = "I couldn't answer just now. Try again in a minute.";

// ---------- what was typed (pure) ----------

const TAKE = /\b(?:use|take|accept|follow|go with|continue with|carry on with|proceed with)\b/;
const ON = /\b(?:continue|carry on|keep going|go on|go ahead|proceed)\b/;
const SUGGESTED = /\b(?:suggest(?:ed|ions?)|recommend(?:ed|ations?))\b/;
const NOT = /\b(?:don't|do not|dont|never|stop|not)\b/;
const ONCE = /\b(?:this time|this once|just this|only this|for now|this one|this stop)\b/;

/**
 * "continue and use all suggested routes", and close phrasings: a short
 * message that says to take or carry on with what's suggested, and doesn't
 * say not to. `fromHere` is false only when it says this time. Null: it
 * isn't that.
 */
export function saysUseSuggestions(text: string): { fromHere: boolean } | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!t || t.length > 120 || t.includes("?") || NOT.test(t)) return null;
  if (!SUGGESTED.test(t) || !(TAKE.test(t) || ON.test(t))) return null;
  return { fromHere: !ONCE.test(t) };
}

/** The assistant a message is for: the first "@Name" that is one of `team` (the longest name wins), and the message without it. */
export function mentioned<T extends { name: string }>(text: string, team: T[]): { assistant: T; text: string } | null {
  let found: { assistant: T; at: number; length: number } | null = null;
  for (const a of team) {
    const name = a.name.trim();
    if (!name) continue;
    const m = new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").exec(text);
    if (!m) continue;
    const at = m.index + m[1].length;
    if (!found || at < found.at || (at === found.at && name.length > found.length)) found = { assistant: a, at, length: name.length };
  }
  if (!found) return null;
  const rest = `${text.slice(0, found.at)}${text.slice(found.at + found.length + 1)}`.replace(/^[\s,:]+/, "").replace(/\s+/g, " ").trim();
  return { assistant: found.assistant, text: rest || text.trim() };
}

// ---------- the routes ----------

async function standingAndGuests(assignmentId: string | null): Promise<Array<{ id: string; name: string }>> {
  const rows = await qRaw<{ id: string }>(`SELECT id FROM team_assistants WHERE assignment_id IS NULL OR assignment_id = $1::uuid ORDER BY created_at, id`, [assignmentId]);
  const team = await Promise.all(rows.map((r) => getAssistant(r.id).catch(() => null)));
  return team.filter((a): a is NonNullable<typeof a> => !!a).map((a) => ({ id: a.id, name: a.name }));
}

type Reply = { text: string; assistant_id: string | null; thread_id?: string | null };

/** What was typed, sent on. Answers the `reply` to post, or null when the runner will say what happens next. */
async function sendOn(text: string, thread: { id: string; title: string } | null, deps: ChatDeps): Promise<Reply | null> {
  const desk = deps.desk ?? NO_DESK;
  const use = thread ? saysUseSuggestions(text) : null;
  if (thread && use) {
    await desk.useSuggestions(thread.id, use.fromHere);
    return null;
  }
  const to = mentioned(text, await (deps.team ?? standingAndGuests)(thread?.id ?? null));
  if (to) return { ...(await deps.turn(to.assistant.id, to.text)), assistant_id: to.assistant.id };
  if (thread && (await desk.waitingStage(thread.id))) {
    await desk.answerStage(thread.id, text);
    return null;
  }
  // Ask is told which thread it's in, so "continue" can name the assignment.
  const asked = thread ? `${text}\n\n(Typed in Team chat, in the thread of the assignment “${thread.title}”, id ${thread.id}.)` : text;
  return { text: await deps.ask(asked), assistant_id: null };
}

export async function handleTeamChatRoutes(req: Request, url: URL, body: () => Promise<Record<string, unknown> | null>, json: Json, deps: ChatDeps): Promise<Response> {
  const dismiss = /\/chat\/([^/]+)\/dismiss\/?$/.exec(url.pathname);
  if (dismiss) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!/^\d{1,15}$/.test(dismiss[1])) return json({ error: "id: a post's id" }, 400);
    const post = await dismissPost(Number(dismiss[1]));
    if (!post) return json({ error: "That post isn't there any more" }, 404);
    return post.waits_for === "dismiss" ? json({ post }) : json({ error: NOT_DISMISSED }, 409);
  }
  if (req.method === "GET") {
    const before = url.searchParams.get("before");
    const limit = url.searchParams.get("limit");
    if (before !== null && !/^\d{1,15}$/.test(before)) return json({ error: "before: a post's id" }, 400);
    return json((await listChat({ before: before === null ? null : Number(before), limit: limit === null ? null : Number(limit) })) satisfies TeamChat);
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const b = (await body()) ?? {};
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return json({ error: "text: say something" }, 400);
  if (text.length > MAX_POST) return json({ error: `text: keep it under ${MAX_POST.toLocaleString("en-GB")} characters` }, 400);
  let thread: { id: string; title: string } | null = null;
  if (b.assignment_id != null) {
    if (typeof b.assignment_id !== "string" || !UUID.test(b.assignment_id)) return json({ error: "assignment_id: not an id" }, 400);
    const [row] = await q<{ id: string; payload: string }>(`SELECT id, payload FROM team_assignments WHERE id = $1::uuid`, [b.assignment_id]);
    if (!row) return json({ error: "That assignment isn't there any more" }, 404);
    let title = "";
    try {
      title = String((JSON.parse(row.payload) as { title?: unknown }).title ?? "");
    } catch {
      // sealed under a key this deploy doesn't have
    }
    thread = { id: row.id, title };
  }

  const posts: TeamPost[] = [await postToTeam({ kind: "said", text, assignment_id: thread?.id })];
  let reply: Reply | null;
  try {
    reply = await sendOn(text, thread, deps);
  } catch (error) {
    // What was typed is kept; the channel says it wasn't answered. Bad input's own line can be shown as it is.
    if (!(error instanceof AthenaInputError)) console.error("Athena team chat: couldn't answer", error instanceof Error ? error.message.slice(0, 160) : error);
    reply = { text: error instanceof AthenaInputError ? error.message : CHAT_FAILED, assistant_id: null };
  }
  // A reply that holds a plan carries its conversation, where the plan card lives, and waits for Go.
  const plan = reply?.thread_id ? { thread_id: reply.thread_id, waits_for: "go" as const } : {};
  if (reply?.text.trim()) posts.push(await postToTeam({ kind: "reply", text: reply.text, assistant_id: reply.assistant_id, assignment_id: thread?.id, ...plan }));
  return json({ posts }, 201);
}
