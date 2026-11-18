/**
 * The owner's word for their own kinds of record ("Wines", "Plants", "Board
 * games"), wherever it's shown: Settings, the Library, Archived, Ask's replies
 * and receipts, and the tool descriptions that teach Ask and MCP what the
 * owner calls them. Every user-visible use of the word comes from here, so
 * renaming it is a change to this file only.
 *
 * Inside a kind, the kind's own name is used instead ("Wines", "New wine").
 * In code they're "custom kinds" and "custom records" (lib/custom-kinds.ts).
 * Pure, shared by the server and the PWA.
 */

export const KIND_WORD = {
  /** "a type": mid-sentence, one. */
  one: "type",
  /** "your types": mid-sentence, several. */
  many: "types",
  /** "Type": a label on its own (the Archived page). */
  One: "Type",
  /** "Types": a heading. */
  Many: "Types",
  /** Settings' section. */
  yours: "Your types",
  /** What Settings' section is for. */
  detail: "Your own kinds of record, like wines or plants",
  /** The Settings address: #/settings/<slug>. */
  slug: "types",
  new: "New type",
  duplicate: "Duplicate type",
} as const;

/** "Wines type", for the odd sentence that needs to say what something is. */
export const kindNoun = (name: string) => `${name} ${KIND_WORD.one}`;
