/**
 * openAsk: the one way into Ask from elsewhere in the app.
 *
 *   openAsk()                                   just open Ask
 *   openAsk({ prompt: "What's next for Lisbon?" })   open it with words in the box
 *   openAsk({ context: { kind: "person", id, label: "Priya Shah" } })
 *                                               open it about something: the item
 *                                               shows as a removable chip above the
 *                                               box, and goes with the next message
 *                                               as an @ mention (lib/mentions.ts),
 *                                               so the answer and the assistant get
 *                                               exactly that item
 *   openAsk({ context, prompt, send: true })    and ask it straight away
 *   openAsk({ assistantId, prompt, send: true }) talk to one of the Team's
 *                                               assistants (docs/team.md): a new
 *                                               conversation with it, unless the
 *                                               open one is already with it.
 *                                               null means Athena, explicitly.
 *
 * Ask opens on the conversation you were in. Nothing is sent unless `send`
 * is set; the owner reads it and presses send. Safe to call from a sheet:
 * open sheets close first, and Esc in Ask goes back to where you were.
 */
import type { LinkKind } from "../../../lib/links";

/** Something in Athena that a question is about. */
export interface AskAbout {
  kind: LinkKind;
  id: string;
  /** Its name as the chip shows it ("Priya Shah", "Design review"). */
  label: string;
}

export interface OpenAskOptions {
  context?: AskAbout | null;
  prompt?: string;
  /** Ask it straight away instead of leaving it in the box. */
  send?: boolean;
  /** Who to talk to (docs/team.md): one of the Team's assistants by id, or null for Athena. Left out: whoever the open conversation is with. */
  assistantId?: string | null;
}

let pending: OpenAskOptions | null = null;
let listener: ((opts: OpenAskOptions) => void) | null = null;
/** Where Ask was opened from, so Esc can go back there. */
let cameFrom: string | null = null;

/** Open Ask, optionally about something and with words ready to send. */
export function openAsk(opts: OpenAskOptions = {}): void {
  const onAsk = location.hash.startsWith("#/ask");
  if (!onAsk) cameFrom = location.hash || "#/";
  // A sheet (a person on a phone, say) closes first, so Ask isn't behind it.
  for (const d of document.querySelectorAll<HTMLDialogElement>("dialog.sheet[open]")) d.close();
  if (listener && onAsk) return listener(opts);
  pending = opts;
  location.hash = "#/ask";
}

/** Ask, as it opens: what it was asked to show, once. */
export function takeAskRequest(): OpenAskOptions | null {
  const p = pending;
  pending = null;
  return p;
}

/** Ask, while it's on screen: take requests directly. */
export function onAskRequest(fn: (opts: OpenAskOptions) => void): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Where Esc in Ask goes: back where it was opened from, else Home. */
export function leaveAsk(): void {
  const to = cameFrom && !cameFrom.startsWith("#/ask") ? cameFrom : "#/";
  cameFrom = null;
  location.hash = to;
}
