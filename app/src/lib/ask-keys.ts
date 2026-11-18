/**
 * Ask's keys, decided in one place so they can be tested and kept clear of
 * the rest of the app:
 *
 *   ⌘J / Ctrl+J   open Ask from anywhere (or focus its box when it's open).
 *                 ⌘K stays "Search or jump to…" (main.ts, components/jump.ts),
 *                 which offers "Ask about “…”" for what was typed.
 *   Esc           close Ask, back to where you were; while editing a message,
 *                 stop editing first. Left alone inside a dialog, a menu, the
 *                 mention picker or a note editor, which use Esc themselves.
 *   ↑             in the empty box: edit your last message.
 *
 * The note editors (app/src/editor) bind Mod-b/i/u/e/l/z/y/a, Mod-Enter,
 * Mod-Shift-b/s and Mod-Alt-c, never Mod-J or Mod-K. An IME composition is
 * never interrupted.
 */

/** The letter that opens Ask with ⌘ or Ctrl. One place, so it can change in one line. */
export const ASK_KEY = "j";
/** The letter for "Search or jump to…" with ⌘ or Ctrl. */
export const JUMP_KEY = "k";

/** ⌘K / Ctrl+K: "Search or jump to…" (not over a dialog). */
export function isJumpKey(e: KeyLike): boolean {
  return !e.isComposing && !!(e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === JUMP_KEY;
}

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface AskKeyState {
  /** Ask is on screen. */
  onAsk: boolean;
  /** A dialog is open (a sheet, ⌘K, a confirmation). */
  dialogOpen: boolean;
  /** Focus is in a note editor or another text field outside Ask's box. */
  inEditor: boolean;
  /** Focus is in Ask's own box. */
  inComposer: boolean;
  composerEmpty: boolean;
  /** A list is open over the box (the @ mention picker). */
  menuOpen: boolean;
  /** Your last message is back in the box being edited. */
  editing: boolean;
  /** There's a message of yours to edit. */
  canEdit: boolean;
}

export type AskKeyAction = "open" | "close" | "cancel-edit" | "edit-last" | null;

export function askKeyAction(e: KeyLike, s: AskKeyState): AskKeyAction {
  if (e.isComposing || e.defaultPrevented) return null;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === ASK_KEY) return s.dialogOpen ? null : "open";
  if (!s.onAsk || s.dialogOpen || s.menuOpen || mod || e.altKey) return null;
  if (e.key === "Escape") {
    if (s.inEditor) return null;
    return s.editing ? "cancel-edit" : "close";
  }
  if (e.key === "ArrowUp" && !e.shiftKey && s.inComposer && s.composerEmpty && !s.editing && s.canEdit) return "edit-last";
  return null;
}
