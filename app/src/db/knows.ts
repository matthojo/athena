/**
 * What Athena knows (Settings → About you → What Athena knows): the lists
 * from GET /api/profile/knows (lib/knows.ts), or from the sample data in
 * sample mode, and the page's two actions. Each goes through the store that
 * owns the thing: the owner's own answers through db/profile.ts (so they
 * queue offline like About you), a detail about someone through
 * db/memory.ts, a waiting one through the Review inbox's accept and reject.
 */
import { isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { loadPeople } from "./data";
import { deviceFacts, loadSuggestions, resolveSuggestion, sampleOwnerFacts, setMemoryArchived, updateFact } from "./memory";
import { saveProfile } from "./profile";
import { ASK_SOURCE, type KnownItem, type KnowsLists } from "../lib/knows";
import type { ConnectionState } from "../types";

const CACHE = "knows";

export async function loadKnows(): Promise<{ lists: KnowsLists; state: ConnectionState }> {
  if (isSampleMode()) {
    const [me, facts, { people }, { items }] = await Promise.all([sampleOwnerFacts(), deviceFacts([]), loadPeople(), loadSuggestions()]);
    const names = new Map(people.map((p) => [p.id, p.name]));
    const remembered = facts.filter((f) => f.subject_kind === "person" && f.source === ASK_SOURCE && f.subject_id && names.has(f.subject_id));
    return {
      lists: { me, people: remembered.map((f) => ({ ...f, person: { id: f.subject_id!, name: names.get(f.subject_id!)! } })), suggestions: items },
      state: "sample",
    };
  }
  try {
    const lists = await request<KnowsLists>("/profile/knows");
    void setMeta(CACHE, JSON.stringify(lists)).catch(() => undefined);
    return { lists, state: "online" };
  } catch (error) {
    const cached = await getMeta(CACHE).catch(() => undefined);
    if (!cached) throw error;
    return { lists: JSON.parse(cached) as KnowsLists, state: "offline" };
  }
}

/** Change what Athena knows. A waiting one is kept with the new value. Resolves "queued" when it'll go once back online. */
export async function editKnown(item: KnownItem, value: string): Promise<"saved" | "queued"> {
  if (item.suggestion) {
    await resolveSuggestion(item.suggestion, "accept", { value });
    return "saved";
  }
  if (!item.fact) return "saved";
  if (item.about.kind === "me") return saveProfile([{ key: item.fact.key, value }]);
  await updateFact(item.fact.id, { value });
  return "saved";
}

/** Forget it: Athena stops using it. A waiting one is turned down. Nothing is deleted for good: forgotten facts go to Archived. */
export async function forgetKnown(item: KnownItem): Promise<"saved" | "queued"> {
  if (item.suggestion) {
    await resolveSuggestion(item.suggestion, "reject");
    return "saved";
  }
  if (!item.fact) return "saved";
  if (item.about.kind === "me") return saveProfile([{ key: item.fact.key, value: "" }]);
  await setMemoryArchived("fact", item.fact.id, true);
  return "saved";
}

// ---------- "Let Ask read transactions" ----------

const SAMPLE_ASK_MONEY = "athena.sample.askMoney";

/** Whether Ask may read card payments and direct debits (GET /api/profile/ask-money). Off by default. */
export async function loadAskMoney(): Promise<boolean> {
  if (isSampleMode()) return localStorage.getItem(SAMPLE_ASK_MONEY) === "on";
  return (await request<{ on: boolean }>("/profile/ask-money")).on;
}

export async function setAskMoney(on: boolean): Promise<boolean> {
  if (isSampleMode()) {
    localStorage.setItem(SAMPLE_ASK_MONEY, on ? "on" : "off");
    return on;
  }
  return (await request<{ on: boolean }>("/profile/ask-money", { method: "PUT", body: JSON.stringify({ on }) })).on;
}
