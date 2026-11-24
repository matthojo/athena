/**
 * lib/shared-scope.ts's limits read from the store: an imported skill's ticked accounts, and which accounts are
 * Slack (its port names none). Kept apart so the scope itself stays pure.
 */
import { listConnectors } from "./connectors";
import { skillTitle } from "./skills";
import { getSkill, type Skill } from "./skills-store";
import type { AccountScope } from "./shared-scope";

/** An imported skill in use: only its ticked accounts from here on. Main Ask's skills only (an assistant's own goes with its assistant). */
export function limitForSkill(scope: AccountScope, s: Pick<Skill, "id" | "imported" | "accounts" | "name" | "assistant_id">): void {
  if (s.imported && !s.assistant_id) scope.limit(s.accounts, skillTitle(s.name), { skill: s.id });
}

/**
 * A skill picked with "/", before any account opens. One that can't be read limits the turn to nothing: it was
 * picked, so it will be in use, and nothing says it's the owner's own.
 */
export async function limitForPicked(scope: AccountScope, id: string): Promise<void> {
  try {
    const s = await getSkill(id);
    if (s) limitForSkill(scope, s);
  } catch {
    scope.limit([], "the skill you picked", { skill: id });
  }
}

/** The Slack accounts' ids. */
export async function slackAccountIds(): Promise<string[]> {
  return (await listConnectors().catch(() => [])).filter((c) => c.provider === "slack").map((c) => c.id);
}
