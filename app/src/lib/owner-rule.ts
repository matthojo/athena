/**
 * The server's owner rule (lib/memory.ts addFact), for sample mode: a fact
 * about the owner from anything but their own hand (a source other than
 * manual or assistant, or any confidence) goes to the Review inbox instead.
 * Accepting a suggestion is the owner's say (`byOwner`).
 */
export function learnedAboutOwner(
  input: { subject_kind: string; source?: string | null; confidence?: number | null },
  writer: { byOwner?: boolean } = {}
): boolean {
  if (input.subject_kind !== "me" || writer.byOwner) return false;
  return (input.confidence ?? null) !== null || !["manual", "assistant", undefined, null].includes(input.source);
}
