/**
 * Ask, opened on a nudge (lib/proactive/): a push's #/ask/nudge/<id>, or a
 * card on Home. It goes through the app-wide openAsk (lib/open-ask.ts) with
 * the nudge's item as the context chip (nudgeAbout) and its suggested first
 * reply in the box. Nothing is sent until the owner sends it. Ask also starts
 * a fresh conversation with the nudge's card above it (what it's about, and
 * "Why am I seeing this?"): takeNudgeCard hands that card over once.
 */
import { fetchNudge, type AppNudge } from "../db/nudges";
import { openAsk, type AskAbout } from "./open-ask";
import { requestOpen, syncAskThreads } from "../db/ask-threads";
import { teamNudgeFrom } from "./team-nudge";

let pending: AppNudge | null = null;

/** The item a nudge is about, as openAsk's context chip: its meeting or its person. */
export function nudgeAbout(n: AppNudge): AskAbout | null {
  const a = n.about.find((x) => x.kind === "event" || x.kind === "person");
  return a ? { kind: a.kind as "event" | "person", id: a.id, label: a.label ?? n.title } : null;
}

/** Open Ask on this nudge. A routine's run opens the conversation it kept (lib/routine-run.ts). */
export function openAskOnNudge(n: AppNudge): void {
  if (n.thread_id) {
    const id = n.thread_id;
    // Made on the server: pull it first, so Ask has it to open.
    void syncAskThreads()
      .catch(() => undefined)
      .then(() => {
        requestOpen(id);
        location.hash = "#/ask";
      });
    return;
  }
  pending = n;
  // A Team assistant's card with no conversation yet: talk to that assistant about it.
  const from = teamNudgeFrom(n as unknown as { rule: string } & Record<string, unknown>);
  openAsk({ context: nudgeAbout(n), prompt: n.prompt, ...(from?.id ? { assistantId: from.id } : {}) });
}

/** Ask, as it takes an openAsk request: the nudge it came from, once. */
export function takeNudgeCard(): AppNudge | null {
  const n = pending;
  pending = null;
  return n;
}

/** A push opened #/ask/nudge/<id>: load it and open Ask on it. */
export async function openAskFromNudge(id: string): Promise<void> {
  const n = await fetchNudge(id);
  if (n) openAskOnNudge(n);
  else openAsk();
}
