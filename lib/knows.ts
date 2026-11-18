/**
 * Settings → About you → What Athena knows (GET /api/profile/knows): every
 * lasting thing Athena keeps about the owner, for the app to group and show
 * with where each came from (app/src/lib/knows.ts groups it).
 *
 *  - me: the owner's current `me` facts (their profile, what they told Ask to
 *    remember, and what they accepted from the Review inbox);
 *  - people: details about people the owner told Ask to remember (source
 *    "assistant"), each with the person's name;
 *  - suggestions: `me` facts Athena worked out and is waiting to be told about.
 *
 * Reads only, through lib/memory.ts. Edits and forgets go through the
 * existing routes: PUT /api/profile, /api/facts/:id and /api/suggestions/:id.
 */
import { getPerson } from "./db";
import { listFacts, listFactsFrom, listSuggestions, type Fact, type Suggestion } from "./memory";

export interface WhatAthenaKnows {
  me: Fact[];
  people: Array<Fact & { person: { id: string; name: string } }>;
  suggestions: Suggestion[];
}

export async function whatAthenaKnows(): Promise<WhatAthenaKnows> {
  const [me, remembered, pending] = await Promise.all([listFacts({ subjectKind: "me" }), listFactsFrom("assistant", { subjectKind: "person" }), listSuggestions({ status: "pending", limit: 200 })]);
  const ids = [...new Set(remembered.map((f) => f.subject_id).filter((x): x is string => !!x))];
  const names = new Map((await Promise.all(ids.map((id) => getPerson(id)))).flatMap((p) => (p ? [[p.id, p.name] as const] : [])));
  return {
    me,
    // A person since archived drops out with them.
    people: remembered.flatMap((f) => (f.subject_id && names.has(f.subject_id) ? [{ ...f, person: { id: f.subject_id, name: names.get(f.subject_id)! } }] : [])),
    suggestions: pending.filter((s) => s.op === "fact" && (s.payload as { subject_kind?: unknown }).subject_kind === "me"),
  };
}
