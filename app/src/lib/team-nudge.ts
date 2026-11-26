/**
 * A nudge from one of the Team's assistants (rule 'team'): a run
 * result that Home shows as "From <Name>" with its avatar. The server side is
 * built in parallel, so this reads the assistant leniently from any of:
 *   n.assistant = { id, name, avatar }
 *   n.payload   = { assistant_id?, name?, avatar }
 *   n.avatar + n.name / n.assistant_id
 * and needs an avatar spec (an object with a species) to show one.
 */
import type { AvatarSpec } from "../../../lib/team-types";

export interface TeamNudgeFrom {
  id: string | null;
  name: string;
  avatar: AvatarSpec;
}

const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

export function teamNudgeFrom(n: { rule: string } & Record<string, unknown>): TeamNudgeFrom | null {
  if (n.rule !== "team") return null;
  for (const src of [obj(n.assistant), obj(n.payload), n]) {
    const avatar = obj(src?.avatar);
    if (!src || !avatar || typeof avatar.species !== "string") continue;
    const name = str(src.name) ?? str(obj(n.assistant)?.name) ?? str(n.name) ?? "Your assistant";
    return { id: str(src.id) ?? str(src.assistant_id) ?? str(n.assistant_id), name, avatar: avatar as unknown as AvatarSpec };
  }
  return null;
}

/** Its name for a team nudge without an avatar, so the card still says who it's from. */
export function teamNudgeName(n: { rule: string } & Record<string, unknown>): string | null {
  if (n.rule !== "team") return null;
  return str(obj(n.assistant)?.name) ?? str(obj(n.payload)?.name) ?? str(n.name);
}
