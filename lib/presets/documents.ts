/**
 * Google Docs: where "Send to Google Docs" puts a note. Joined into
 * CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * It feeds no collection and isn't offered to Claude: Athena writes to it
 * itself (lib/documents.ts, netlify/lib/connectors/google-docs.ts). The only
 * permission asked for is drive.file, so Google lets Athena see and change
 * only the files Athena made: its "Athena" folder and the docs in it.
 */
import type { ConnectorPreset } from "../connector-presets";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DOCS_URL = "https://docs.googleapis.com/v1";

/** Does Athena call Google's API itself for this account? Every Google Docs account. */
export function documentsDirect(c: { provider: string; auth_type: string }): boolean {
  return c.provider === "google-docs" && c.auth_type === "oauth";
}

export const DOCUMENTS_PRESETS: ConnectorPreset[] = [
  {
    id: "google-docs",
    label: "Google Docs",
    tagline: "Send notes to new docs",
    icon: "note",
    category: "docs",
    aliases: ["google drive", "drive", "docs", "gdocs", "export", "share a note"],
    url: GOOGLE_DOCS_URL,
    auth: "oauth",
    scope: DRIVE_FILE_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Google",
    readTools: [],
    recipes: [],
    help:
      "Athena makes a folder called Athena in your Drive and puts each note you send there as a new doc. It asks only for drive.file, so it can see and change the files it made and nothing else in your Drive. Use the same OAuth client as Gmail: turn on the Google Docs API and the Google Drive API in its project.",
    live: {
      meta: "Notes you send",
      foot: "Athena can see and change only the docs it made, in its Athena folder.",
      added: { title: "Send notes to Google Docs", sentence: "Open a note and choose Send to Google Docs. The doc goes in an Athena folder in your Drive." },
    },
  },
];
