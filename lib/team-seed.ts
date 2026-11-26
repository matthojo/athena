/**
 * Team: a character from a seed. Pure and
 * deterministic: the same seed always gives the same avatar, personality and
 * name, on the server (a routine becoming an assistant, a new one with no
 * character yet) and in the app (setup's Shuffle).
 *
 * The generator lives in the character kit (app/src/team/kit/procedural.ts,
 * no DOM, no CSS), so the server and the app draw the same characters. This
 * module narrows its types to the shared ones in team-types.ts.
 */
import * as kit from "../app/src/team/kit/procedural";
import type { AvatarSpec, Personality } from "./team-types";

export const avatarFromSeed = (seed: string): AvatarSpec => kit.avatarFromSeed(seed) as AvatarSpec;
export const personalityFromSeed = (seed: string): Personality => kit.personalityFromSeed(seed) as Personality;
/** `taken`: names already on the team, skipped where possible. */
export const nameFromSeed = (seed: string, taken: readonly string[] = []): string => kit.nameFromSeed(seed, taken);

/** A fresh seed: random, short, safe in a URL. */
export function newSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
