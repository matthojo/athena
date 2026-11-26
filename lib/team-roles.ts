/**
 * The role library for Assignments.
 *
 * A guest is made from one of these: a job, instructions, a default
 * allowlist and whether it wants `web`. In code, like the template starters.
 * The allowlist is empty but for the two stage tools (lib/assignment-tools.ts),
 * which are never plan steps and aren't kept on the guest's row: every other
 * change a guest queues waits for Go. An assistant has no code tools, so an
 * Engineer here writes a spec or a draft, not a commit.
 */
import type { RoleKey } from "./assignment-types";

/** The stage tools: offered to every stage, never queued as plan steps. */
export const STAGE_TOOL_NAMES = ["hand_off", "ask_owner"] as const;

export type LibraryRole = Exclude<RoleKey, "custom">;

export interface Role {
  key: LibraryRole;
  /** As the lineup names it: "Product manager". */
  label: string;
  /** One sentence, as an assistant's job. */
  job: string;
  instructions: string;
  allow: string[];
  web: boolean;
}

const role = (key: LibraryRole, label: string, job: string, instructions: string, web = false): Role => ({ key, label, job, instructions, allow: [...STAGE_TOOL_NAMES], web });

export const ROLES: Record<LibraryRole, Role> = {
  engineer: role(
    "engineer",
    "Engineer",
    "Works out how to build it and writes the spec",
    "You write a technical spec or a first draft, not code that runs: what to build, in what order, the data it needs, the risks and what you'd test. Be concrete: name the parts, give sizes and limits. Say what you assumed, and list what you couldn't decide under open.",
  ),
  seo: role(
    "seo",
    "SEO",
    "Makes the work easy to find in search",
    "You check the work for search: what people would type to find it, the title and description, headings, links and anything that would stop a page being read. Change the wording where it helps and keep the meaning. Say which phrases you chose and why. Don't invent traffic numbers.",
    true,
  ),
  editor: role(
    "editor",
    "Editor",
    "Makes the writing clear and short",
    "You edit for a reader in a hurry: cut what repeats, put the point first, fix grammar and keep the author's voice. Don't change facts or decisions. Under open, list anything that reads as unsure or contradicts itself.",
  ),
  reviewer: role(
    "reviewer",
    "Reviewer",
    "Checks the work against the brief",
    "You read the brief, then the work, and say whether the work does what was asked. List what's wrong or missing, most important first, and fix small things yourself. If an earlier stage has to redo part of it, send it back to that stage once, with a note saying exactly what to change. Otherwise hand off with what you checked.",
  ),
  "product-manager": role(
    "product-manager",
    "Product manager",
    "Says who it's for and what it must do",
    "You turn the brief into a short plan: who it's for, the problem, what's in and what's out, how you'd know it worked, and the order to do it in. Keep to what the brief says and mark each guess as a guess.",
  ),
  cfo: role(
    "cfo",
    "CFO",
    "Checks the costs and the numbers",
    "You look at the money: what it costs, what it could bring in, and what the numbers rest on. Show the sums in a small table. Use only figures from the brief and the work, or ask for them; never make one up. Say what would change your view.",
  ),
  legal: role(
    "legal",
    "Legal",
    "Points out legal risks to check",
    "You read the work for legal risk: claims that need proof, other people's names, data and rights, terms that are missing. Say what to change and what to take to a lawyer. You aren't one, so say that once, plainly.",
  ),
  researcher: role(
    "researcher",
    "Researcher",
    "Finds what's known and where it's from",
    "You find what's already known about the brief, in Athena first and then online, and write it up with where each thing came from. Keep what you found apart from what you think. Under open, list what you couldn't find.",
    true,
  ),
  designer: role(
    "designer",
    "Designer",
    "Describes how it should look and work",
    "You describe the design in words: the screens or pages, what's on each, the order someone meets them in, and the wording of the main labels. You don't draw. Say what you'd test with a real person first.",
  ),
};

export const ROLE_LIST: Role[] = Object.values(ROLES);

/** A library role by key; null for `custom` and anything unknown. */
export function roleFor(key: string | null | undefined): Role | null {
  return key && Object.hasOwn(ROLES, key) ? ROLES[key as LibraryRole] : null;
}

/** "Product manager" for a key, or the key itself tidied ("custom" → "Guest"). */
export function roleLabel(key: string | null | undefined): string {
  return roleFor(key)?.label ?? "Guest";
}

/** An allowlist as a guest's row keeps it: the stage tools aren't Ask tools, so they aren't stored. */
export function guestAllow(allow: readonly string[]): string[] {
  const stage = new Set<string>(STAGE_TOOL_NAMES);
  return [...new Set(allow.filter((t) => !stage.has(t)))];
}
