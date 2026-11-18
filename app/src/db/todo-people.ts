/**
 * "Link to Priya Shah" on the device: for each open to-do with nobody linked,
 * the people its words name (rules in lib/todo-person.ts). Live from the API
 * with the app's own sign-in, the last answer offline, and worked out here
 * from the sample people in sample mode. Linking is an ordinary to-do save.
 */

import { ApiError, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { loadCommitments, memoryChanged } from "./memory";
import { loadRecords, OfflineError } from "./records";
import { sampleIdentities } from "./sample-memory";
import { peopleNamedIn, wantsPersonSuggestion } from "../../../lib/todo-person";
import type { PersonRef } from "../types";

/** To-do id → who to offer (one, or a few to choose from). */
export type TodoPeople = Record<string, PersonRef[]>;

const CACHE = "todoPeople";
const SAMPLE_DISMISSED = "sampleTodoPeopleDismissed";

async function sampleDismissed(): Promise<string[]> {
  try {
    return JSON.parse((await getMeta(SAMPLE_DISMISSED)) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export async function loadTodoPeople(): Promise<TodoPeople> {
  if (isSampleMode()) {
    const [{ items: todos }, { items: people }, skip] = await Promise.all([loadCommitments(), loadRecords("person"), sampleDismissed()]);
    const aliases = sampleIdentities().filter((i) => i.kind === "alias");
    const known = people.filter((p) => !p.archived_at).map((p) => ({ id: p.id, name: p.name, last_contacted_at: p.last_contacted_at, aliases: aliases.filter((a) => a.person_id === p.id).map((a) => a.value) }));
    const out: TodoPeople = {};
    for (const c of todos) {
      if (!wantsPersonSuggestion(c) || skip.includes(c.id)) continue;
      const named = peopleNamedIn(c.title, known);
      if (named.length) out[c.id] = named;
    }
    return out;
  }
  try {
    const { suggestions } = await request<{ suggestions: TodoPeople }>("/todo-people");
    await setMeta(CACHE, JSON.stringify(suggestions));
    return suggestions;
  } catch {
    try {
      return JSON.parse((await getMeta(CACHE)) ?? "{}") as TodoPeople;
    } catch {
      return {};
    }
  }
}

/** Not about them: this to-do isn't offered anyone again. */
export async function dismissTodoPerson(id: string): Promise<void> {
  if (isSampleMode()) {
    await setMeta(SAMPLE_DISMISSED, JSON.stringify([...(await sampleDismissed()), id]));
  } else {
    if (!navigator.onLine) throw new OfflineError();
    try {
      await request<{ dismissed: boolean }>(`/todo-people/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new OfflineError();
    }
  }
  memoryChanged();
}
