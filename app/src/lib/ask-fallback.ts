/**
 * When Ask shows a keyword search in place of a written answer: why, in a
 * sentence; the button that writes the answer in its place; and which
 * fallbacks run again by themselves when the connection returns.
 *
 * Pure but for writeButton, which builds one element with the app's `h`.
 */
import { h } from "./dom";

export type FallbackCause = "offline" | "busy" | "setup" | "signin" | "failed";

const statusOf = (error: unknown): number | undefined => (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined);

/** Why the written answer couldn't be had. `online`: navigator.onLine when it failed. */
export function fallbackCause(error: unknown, online: boolean): FallbackCause {
  if (!online) return "offline";
  const status = statusOf(error);
  if (status === 429) return "busy";
  if (status === 503) return "setup";
  if (status === 401) return "signin";
  return "failed";
}

export const FALLBACK_NOTE: Record<FallbackCause, string> = {
  offline: "You're offline, so this is a keyword search. I'll write the answer when you're back online.",
  busy: "Athena's AI is still busy, so this is a keyword search.",
  setup: "Written answers need Athena's AI, which isn't set up yet, so this is a keyword search.",
  signin: "Athena couldn't sign you in for that, so this is a keyword search. Sign out from the menu, then sign in again.",
  failed: "Athena couldn't write an answer just now, so this is a keyword search.",
};

export const WRITE_LABEL = "Write the answer";

/**
 * A follow-up's reply couldn't be had, and it keeps to the context it has.
 * A follow-up means something only with the turns before it, so its words are never keyword-searched: the
 * message is kept, this line says why there's no reply, and Try again asks it again with the same history.
 * A first message in a new chat still gets the keyword search (FALLBACK_NOTE).
 */
export const UNREACHED_NOTE: Record<FallbackCause, string> = {
  offline: "You're offline, so I haven't answered this yet. I'll answer when you're back online.",
  busy: "Athena's AI is busy, so I haven't answered this yet. Your message is kept.",
  setup: "Athena's AI isn't set up yet, so I can't answer this.",
  signin: "Athena couldn't sign you in, so I haven't answered this yet. Sign out from the menu, then sign in again.",
  failed: "Athena's AI couldn't be reached, so I haven't answered this yet. Your message is kept.",
};
/** While the one automatic retry is on its way. */
export const UNREACHED_RETRYING = "Athena's AI couldn't be reached. Trying once more in a moment.";
export const TRY_AGAIN_LABEL = "Try again";
export const TRY_NOW_LABEL = "Try now";
/** How long before a follow-up that couldn't be reached is asked again by itself, once. */
export const AUTO_RETRY_MS = 8_000;

/**
 * What to show when the reply couldn't be had. With Athena's turns before it in the chat, the message is a
 * follow-up: "unreached", never a search of its words. A first message keeps the keyword search.
 */
export function fallbackKind(earlierTurns: number): "unreached" | "keywords" {
  return earlierTurns > 0 ? "unreached" : "keywords";
}

/**
 * The reply couldn't be had: what the chat shows in its place. `earlierTurns`: the turns of the conversation
 * sent with the message (lib/ask-history.ts), none for a first message. `alreadyTried`: its one automatic
 * retry has been used.
 */
export function afterFailure(error: unknown, now: { online: boolean; earlierTurns: number; alreadyTried: boolean }): { show: "keywords"; note: string } | { show: "unreached"; cause: FallbackCause; note: string; retryInMs: number | null } {
  const cause = fallbackCause(error, now.online);
  if (fallbackKind(now.earlierTurns) === "keywords") return { show: "keywords", note: FALLBACK_NOTE[cause] };
  const again = retriesItself(cause, now.alreadyTried);
  return { show: "unreached", cause, note: again ? UNREACHED_RETRYING : UNREACHED_NOTE[cause], retryInMs: again ? AUTO_RETRY_MS : null };
}

/**
 * Does an unreached follow-up ask again by itself? Once, and only when asking again could help: busy or out of
 * reach. Offline waits for the connection (takeOfflineFallbacks); a missing setup or sign-in needs the owner.
 */
export function retriesItself(cause: FallbackCause, alreadyTried: boolean): boolean {
  return !alreadyTried && (cause === "busy" || cause === "failed");
}

/** What a fallback needs to be found again. */
export interface FallbackState {
  role: string;
  /** The keyword search it shows; null while an answer is being written. */
  fallback?: unknown;
  reply?: unknown;
  /** It fell back because there was no connection, and hasn't been run again since. */
  offline?: boolean;
  /** A follow-up with no reply and no keyword search: why (UNREACHED_NOTE). */
  unreached?: FallbackCause;
}

/** Is this a keyword search shown in place of a written answer? Those get the button. */
export const isFallback = (m: FallbackState): boolean => m.role === "answer" && !!m.fallback && !m.reply;

/**
 * The connection is back: the fallbacks to write again, oldest first. Each
 * runs again once: taking it clears its mark, so a second reconnect finds
 * nothing. Nothing while the chat isn't open, there's no connection, or a
 * reply is being written.
 */
export function takeOfflineFallbacks<M extends FallbackState>(messages: readonly M[], now: { open: boolean; online: boolean; busy: boolean }): M[] {
  if (!now.open || !now.online || now.busy) return [];
  const due = messages.filter((m) => isFallback(m) && m.offline);
  for (const m of due) m.offline = false;
  return due;
}

/** "Write the answer": the keyword search gives way to a written answer, where it is. */
export function writeButton(onWrite: () => void, icon: Node | null = null, cls = "btn btn--primary btn--sm answer__write"): HTMLButtonElement {
  const b = h("button", { class: cls, type: "button" }, icon, WRITE_LABEL) as HTMLButtonElement;
  b.addEventListener("click", () => {
    if (b.disabled) return;
    // One tap, one answer.
    b.disabled = true;
    onWrite();
  });
  return b;
}
