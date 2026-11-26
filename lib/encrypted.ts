/**
 * What a field shows when it's encrypted at rest and can't be opened where
 * it's being read (docs: security/encryption). Shared by the server (lib/data-box.ts
 * puts these in place of the value) and the PWA (which shows such notes
 * read-only). Pure, no imports.
 *
 *  - Locked: this copy of Athena has no key at all, e.g. a deploy preview
 *    reading its copy of the production database.
 *  - Unreadable: there is a key, but not the one this value was sealed with
 *    (an old key left out after a rotation), or the value was altered.
 */

export const LOCKED_PREFIX = "Encrypted — open on ";
export const UNREADABLE_TEXT = "Encrypted — can't be read with the current key";

/** "Encrypted — open on athena.example.com". */
export function lockedText(host: string): string {
  return `${LOCKED_PREFIX}${host}`;
}

const PLACEHOLDER = /^Encrypted — (?:open on \S+|can't be read with the current key)$/;

/** True only for the whole placeholder, never for text that merely mentions it. */
export function isEncryptedPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.length < 120 && PLACEHOLDER.test(value);
}
