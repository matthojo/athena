/**
 * The picker's listbox keyboard (docs/ai-models.md, "Accessible by default"),
 * with no DOM so it can be tested: Up and Down move one, Home and End go to
 * the ends, Page Up and Page Down move a screenful, and typing jumps to the
 * next option whose name starts with what was typed. Typing the same letter
 * again cycles through the options that start with it.
 */

export interface ListKeyState {
  /** The active option, or -1 for none yet. */
  index: number;
  /** What's been typed for type-ahead, and when the last key came. */
  typed: string;
  at: number;
}

/** Type-ahead forgets what was typed after this long without a key. */
export const TYPEAHEAD_MS = 600;
const PAGE = 8;

/** Where a key moves the active option; null when the listbox doesn't handle the key. */
export function listKey(key: string, s: ListKeyState, labels: readonly string[], now: number): ListKeyState | null {
  const n = labels.length;
  if (!n) return null;
  const at = (index: number): ListKeyState => ({ index: Math.max(0, Math.min(n - 1, index)), typed: "", at: now });
  switch (key) {
    case "ArrowDown":
      return at(s.index < 0 ? 0 : s.index + 1);
    case "ArrowUp":
      return at(s.index < 0 ? n - 1 : s.index - 1);
    case "Home":
      return at(0);
    case "End":
      return at(n - 1);
    case "PageDown":
      return at(s.index + PAGE);
    case "PageUp":
      return at(s.index - PAGE);
  }
  if (key.length !== 1 || key === " " && !s.typed) return null;
  const fresh = now - s.at > TYPEAHEAD_MS;
  const typed = (fresh ? "" : s.typed) + key.toLowerCase();
  // The same letter again: cycle among the options starting with it, from the one after this.
  const repeat = typed.length > 1 && [...typed].every((c) => c === typed[0]);
  const needle = repeat ? typed[0] : typed;
  const from = needle.length === 1 ? s.index + 1 : Math.max(0, s.index);
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (labels[i].toLowerCase().startsWith(needle)) return { index: i, typed, at: now };
  }
  return { index: s.index, typed, at: now };
}
