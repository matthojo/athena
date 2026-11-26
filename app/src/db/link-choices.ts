/**
 * The owner's Card, Mention and Embed choices for web links in a note Athena
 * wrote (lib/note-link-choices.ts). Kept on the server
 * beside the note, never in its Markdown, so only this editor can make one.
 * Offline or in sample mode there are none, and every such link stays plain.
 */
import { isSampleMode, request } from "./api";
import type { ChoiceMode, LinkChoice } from "../../../lib/links";

export async function loadLinkChoices(noteId: string): Promise<LinkChoice[]> {
  if (isSampleMode() || !navigator.onLine) return [];
  try {
    return (await request<{ choices: LinkChoice[] }>(`/notes/${encodeURIComponent(noteId)}/link-choices`)).choices ?? [];
  } catch {
    return [];
  }
}

/** Remember that the owner chose `mode` for `url` in this note ("link" forgets it). A failure is quiet: the link is plain next time. */
export async function saveLinkChoice(noteId: string, url: string, mode: ChoiceMode | "link"): Promise<void> {
  if (isSampleMode() || !navigator.onLine) return;
  await request(`/notes/${encodeURIComponent(noteId)}/link-choices`, { method: "PUT", body: JSON.stringify({ url, mode }) }).catch(() => undefined);
}
