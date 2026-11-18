/**
 * Routines become assistants (docs/team.md, owner 12 Nov 2026). Each
 * `ask_routines` row becomes a Team assistant: its title as the name and
 * job, its question as the instructions, a schedule trigger on the same days
 * and time, and a character from a seed of the routine's id. `routine_id`
 * links the two (one assistant per routine, by a unique index), so the step
 * is safe to run again: a routine that already has its assistant is skipped.
 *
 * The reminders job runs it until it has finished once, then the settings key
 * says so and routines stop running; until then, a routine that already has
 * an assistant doesn't run as a routine either (lib/routine-run.ts). The
 * routine rows stay, so old What Ask did entries still resolve.
 */
import { qRaw } from "./db";
import { listRoutines, titleFrom, type Routine } from "./routines";
import { createAssistant } from "./team";
import { avatarFromSeed, personalityFromSeed } from "./team-seed";
import { MAX_JOB, MAX_NAME, type TeamAssistantInput } from "./team-types";

export const MIGRATED_KEY = "team.routines_migrated";

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);

/** The assistant a routine becomes. Pure. */
export function assistantFromRoutine(r: Pick<Routine, "id" | "title" | "prompt" | "days" | "time" | "paused">): TeamAssistantInput {
  const title = (r.title || titleFrom(r.prompt)).replace(/\s+/g, " ").trim();
  return {
    name: cut(title, MAX_NAME),
    job: cut(title, MAX_JOB),
    instructions: r.prompt,
    avatar: avatarFromSeed(r.id),
    personality: personalityFromSeed(r.id),
    paused: r.paused,
    allow: [],
    triggers: [{ kind: "schedule", days: r.days, time: r.time }],
  };
}

export async function routinesMigrated(): Promise<boolean> {
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [MIGRATED_KEY]);
  return !!row;
}

/** Routines that already have their assistant. */
export async function migratedRoutineIds(): Promise<Set<string>> {
  return new Set((await qRaw<{ routine_id: string }>(`SELECT routine_id FROM team_assistants WHERE routine_id IS NOT NULL`)).map((r) => r.routine_id));
}

/**
 * Make an assistant for each routine that hasn't one. Done (and marked, so
 * it never runs again) only when every routine has one; one that can't be
 * made (the team is full, say) leaves it to try again next pass.
 */
export async function migrateRoutines(now = new Date()): Promise<{ made: number; already: number; failed: number; done: boolean }> {
  if (await routinesMigrated()) return { made: 0, already: 0, failed: 0, done: true };
  const have = await migratedRoutineIds();
  let made = 0;
  let already = 0;
  let failed = 0;
  for (const r of await listRoutines()) {
    if (have.has(r.id)) {
      already++;
      continue;
    }
    // Sealed under a key this deploy doesn't have: it can't run as a routine either, so there's nothing to move.
    if (!r.prompt) continue;
    try {
      const a = await createAssistant(assistantFromRoutine(r), { routineId: r.id, now });
      // The slot the routine last ran for is the trigger's, so a run isn't repeated.
      if (r.last_slot) await qRaw(`UPDATE team_triggers SET last_slot = $2 WHERE assistant_id = $1::uuid AND kind = 'schedule'`, [a.id, r.last_slot]);
      if (r.last_run_at) await qRaw(`UPDATE team_assistants SET last_run_at = $2 WHERE id = $1::uuid`, [a.id, r.last_run_at]);
      made++;
    } catch (error) {
      // Another pass made it at the same moment (the unique index): that's fine.
      if ((await migratedRoutineIds()).has(r.id)) already++;
      else {
        failed++;
        console.error("Athena team: couldn't make an assistant from a routine", (error as Error).message?.slice(0, 160));
      }
    }
  }
  const done = failed === 0;
  if (done) await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [MIGRATED_KEY, JSON.stringify({ at: now.toISOString(), made, already })]);
  return { made, already, failed, done };
}
