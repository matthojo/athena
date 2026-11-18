/**
 * Where an answer in Settings → About you came from, in words. The weekly
 * profile learner (source "profile-learner") reads "Learned from your
 * activity"; other sources keep their readable names ("Learned from Gmail").
 */

import { sourceText } from "./sources";
import type { Fact } from "../types";

export const PROFILE_LEARNER_SOURCE = "profile-learner";

export function provenanceLine(fact: Pick<Fact, "source" | "confidence">): string {
  if (fact.confidence === null || fact.confidence === undefined) return "You told Athena";
  if (fact.source === PROFILE_LEARNER_SOURCE) return "Learned from your activity";
  return `Learned from ${sourceText(fact.source ?? null)}`;
}
