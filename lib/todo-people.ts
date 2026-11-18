/**
 * "Link to Priya Shah": the person an unlinked to-do names, offered in To do
 * and the to-do's sheet (rules in lib/todo-person.ts).
 *
 * Read side only, for the app's own sign-in or a full key (GET /api/todo-people,
 * netlify/lib/todo-people-routes.ts). A capture key never reaches this: a
 * Shortcut files the plain text, and the owner links the person here later.
 * Linking itself is the ordinary PATCH /api/commitments/:id { person_id }.
 *
 * Nothing new is stored about a person. Names, nicknames and to-do titles are
 * opened in the Function, compared in memory and dropped. A dismissed
 * suggestion is remembered as the to-do's id alone, in the settings table
 * under `todo_person_dismissed` (ids stay readable everywhere; no name does).
 */
import { AthenaInputError, listPeople, q } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { listCommitments, type PersonRef } from "./memory";
import { peopleNamedIn, wantsPersonSuggestion, type NamedPerson } from "./todo-person";

const KEY = "todo_person_dismissed";
/** Newest kept; an older dismissal than this many may be offered again. */
const MAX_DISMISSED = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function dismissed(): Promise<string[]> {
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
  return Array.isArray(row?.value) ? row.value.filter((v): v is string => typeof v === "string" && UUID.test(v)) : [];
}

/** Everyone live, with their nicknames, as the matcher wants them. Names a preview can't open are left out. */
async function knownPeople(): Promise<NamedPerson[]> {
  const [people, aliases] = await Promise.all([
    listPeople(Number.MAX_SAFE_INTEGER),
    q<{ person_id: string; value: string }>(`SELECT person_id, value FROM identities WHERE kind = 'alias'`),
  ]);
  const byPerson = new Map<string, string[]>();
  for (const a of aliases) if (a.value && !isEncryptedPlaceholder(a.value)) byPerson.set(a.person_id, [...(byPerson.get(a.person_id) ?? []), a.value]);
  return people
    .filter((p) => p.name && !isEncryptedPlaceholder(p.name))
    .map((p) => ({ id: p.id, name: p.name, aliases: byPerson.get(p.id), last_contacted_at: p.last_contacted_at ? new Date(p.last_contacted_at).toISOString() : null }));
}

/** For each open to-do with nobody linked: the people its title names (a few at most). To-dos with none, or dismissed, are left out. */
export async function todoPersonSuggestions(): Promise<Record<string, PersonRef[]>> {
  const todos = (await listCommitments({ status: "open", limit: 1000 })).filter(wantsPersonSuggestion);
  if (!todos.length) return {};
  const [people, skip] = await Promise.all([knownPeople(), dismissed()]);
  const out: Record<string, PersonRef[]> = {};
  for (const c of todos) {
    if (skip.includes(c.id) || isEncryptedPlaceholder(c.title)) continue;
    const named = peopleNamedIn(c.title, people);
    if (named.length) out[c.id] = named;
  }
  return out;
}

/** The owner said no for this to-do: don't offer it again. */
export async function dismissTodoPerson(commitmentId: string): Promise<void> {
  if (!UUID.test(commitmentId)) throw new AthenaInputError("Invalid to-do id");
  const id = commitmentId.toLowerCase();
  const list = [...(await dismissed()).filter((d) => d !== id), id].slice(-MAX_DISMISSED);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(list)],
  );
}
