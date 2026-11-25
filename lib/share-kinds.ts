/**
 * Community: the three kinds of thing people share, and what every shared file has in common. Pure and shared by
 * the server and the app.
 *
 * A shared item is a folder of plain files: data, never code. One file names its kind:
 *
 *   assistant.json   a Team assistant (lib/team-share.ts), with its SKILL.md and reference files beside it
 *   SKILL.md         a skill in Claude's format (lib/skills.ts), with its reference files
 *   flow.json        a flow (lib/flow-share.ts)
 *
 * The JSON files carry the same optional header: `format` (the file format, a whole number), `version` (the
 * author's own, free text like 1.2.0), `author` (a GitHub username) and `based_on` (the item it was made from: a
 * github.com link, or its listing on the Community site). A SKILL.md has no header of its own: its kind comes from its name.
 */
import { basedOnLink } from "./team-share";

export const SHARE_KINDS = ["assistant", "skill", "flow"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

/** The file that says what a folder is. */
export const KIND_FILES: Readonly<Record<ShareKind, string>> = {
  assistant: "assistant.json",
  skill: "SKILL.md",
  flow: "flow.json",
};

export const isShareKind = (v: unknown): v is ShareKind => typeof v === "string" && (SHARE_KINDS as readonly string[]).includes(v);

/** The header every shared JSON file may carry, beside its own `format`. All optional. */
export interface ShareHeader {
  /** Free text, like 1.2.0. */
  version?: string;
  /** A GitHub username, when the author wants credit. */
  author?: string;
  /** The item this one was made from: a github.com link, or its listing on the Community site (lib/community-site.ts). */
  based_on?: string;
}

const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;

/**
 * The header fields of a parsed file, checked the way lib/team-share.ts readShared checks them: anything that
 * doesn't fit is left out rather than refused, since none of it changes what the item does. Pure.
 */
export function readHeader(raw: Record<string, unknown>): ShareHeader {
  const version = typeof raw.version === "string" && VERSION.test(raw.version.trim()) ? raw.version.trim() : undefined;
  const handle = typeof raw.author === "string" ? raw.author.trim().replace(/^@/, "") : "";
  const author = GITHUB_USER.test(handle) ? handle : undefined;
  const basedOn = basedOnLink(raw.based_on);
  return { ...(version ? { version } : {}), ...(author ? { author } : {}), ...(basedOn ? { based_on: basedOn } : {}) };
}

const fileName = (path: string) => (path.split("/").pop() ?? "").toLowerCase();
const depthOf = (path: string) => path.split("/").length;
const hidden = (path: string) => path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX");

/** Which kind a file name identifies, if any (case-insensitive). Pure. */
export function kindOfFile(path: string): ShareKind | null {
  const name = fileName(path);
  for (const kind of SHARE_KINDS) if (KIND_FILES[kind].toLowerCase() === name) return kind;
  return null;
}

/**
 * What a folder, zip or link's files are, from their paths alone. The shallowest identifying file decides, so a
 * folder of several items is named by the one at its top. At that level an assistant.json wins (the SKILL.md beside
 * it is the assistant's own skill); a flow.json beside a SKILL.md, with no assistant.json, can't be told apart and
 * gives null. Hidden files and macOS's __MACOSX folder are ignored. Null when nothing identifies it. Pure.
 */
export function detectKind(paths: readonly string[]): ShareKind | null {
  const found = paths
    .map((p) => p.replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter((p) => p && !hidden(p))
    .flatMap((p) => {
      const kind = kindOfFile(p);
      return kind ? [{ kind, depth: depthOf(p) }] : [];
    });
  if (!found.length) return null;
  const top = Math.min(...found.map((f) => f.depth));
  const kinds = new Set(found.filter((f) => f.depth === top).map((f) => f.kind));
  if (kinds.has("assistant")) return "assistant";
  if (kinds.size > 1) return null;
  return [...kinds][0];
}
