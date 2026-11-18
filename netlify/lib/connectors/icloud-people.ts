/**
 * Contacts into People. When a collection run links a person (a meeting's
 * attendee, someone on an invite) and one of its accounts offers
 * list_contacts (iCloud Contacts), Athena looks the person up there itself
 * and fills in what People is missing: their phone, birthday and company.
 *
 * Deterministic, not left to the model: a match is an exact email, or else
 * an exact name that only one contact has. Only empty fields are filled, so
 * nothing the owner typed is ever replaced, and each person is looked up at
 * most once a run. The address book is read through the account's own
 * allowed tools (callTool), so turning list_contacts off turns this off.
 */
import { getPerson, upsertOrganisation, upsertPerson, type Person } from "../../../lib/db";
import { findEntityByName } from "../../../lib/connectors";
import { callTool, type OpenConnector } from "./mcp-client";

/** A contact as list_contacts gives it (icloud-contacts.ts's contactOut). */
export interface ListedContact {
  id?: string;
  name?: string;
  organisation?: string;
  title?: string;
  emails?: string[];
  phones?: string[];
  birthday?: string;
}

/** "priya@acme.example (work)" → "priya@acme.example". */
const bare = (v: string) => v.replace(/\s+\([^)]*\)$/, "").trim();
const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The one contact that is this person: same email, or else the only contact with exactly their name. */
export function matchContact(contacts: ListedContact[], person: { name: string; email?: string | null }): ListedContact | null {
  const email = person.email?.trim().toLowerCase();
  if (email) {
    const byEmail = contacts.find((c) => (c.emails ?? []).some((e) => bare(e).toLowerCase() === email));
    if (byEmail) return byEmail;
  }
  const name = norm(person.name);
  if (!name || !name.includes(" ")) return null;
  const byName = contacts.filter((c) => c.name && norm(c.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

/** What a contact adds to a person: only what People doesn't have yet. */
export function contactFill(person: Pick<Person, "phone" | "birthday" | "organisation">, c: ListedContact): { phone?: string; birthday?: string; organisation?: string } {
  const phone = c.phones?.map(bare).find((p) => /\d{5}/.test(p.replace(/\D/g, "")));
  const birthday = c.birthday && /^(\d{4}|-)-\d{2}-\d{2}$/.test(c.birthday) ? c.birthday : undefined;
  return {
    phone: !person.phone && phone ? phone : undefined,
    birthday: !person.birthday && birthday ? birthday : undefined,
    organisation: !person.organisation && c.organisation?.trim() ? c.organisation.trim() : undefined,
  };
}

const MAX_PAGES = 40;

/** Every contact on an account, through its list_contacts tool. Null when it can't be read. */
export async function readContacts(open: OpenConnector): Promise<ListedContact[] | null> {
  const out: ListedContact[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: { contacts?: ListedContact[]; nextPageToken?: string };
    try {
      const r = await callTool(open, "list_contacts", { pageSize: 200, ...(token ? { pageToken: token } : {}) });
      if (r.isError) return null;
      body = JSON.parse(r.text);
    } catch {
      return null;
    }
    out.push(...(body.contacts ?? []));
    token = body.nextPageToken;
    if (!token) return out;
  }
  return out;
}

export interface ContactsDirectory {
  /** Fill in a person from the contacts; returns what was added (nothing when there's no clear match). */
  fill(personId: string, name: string, email?: string): Promise<string[]>;
}

/**
 * The contacts a run can read, or undefined when none of its accounts offers
 * list_contacts. Read once, on the first person that needs it.
 */
export function contactsDirectory(
  opened: OpenConnector[],
  allowed: Map<OpenConnector, Set<string>>,
  deps: { read?: typeof readContacts; getPerson?: typeof getPerson; upsertPerson?: typeof upsertPerson; organisation?: (name: string) => Promise<string> } = {},
): ContactsDirectory | undefined {
  const books = opened.filter((o) => allowed.get(o)?.has("list_contacts"));
  if (!books.length) return undefined;
  const read = deps.read ?? readContacts;
  const get = deps.getPerson ?? getPerson;
  const save = deps.upsertPerson ?? upsertPerson;
  const organisation = deps.organisation ?? (async (name: string) => (await findEntityByName("organisation", name)) ?? (await upsertOrganisation({ name })).id);
  let all: Promise<ListedContact[]> | undefined;
  const done = new Set<string>();
  return {
    async fill(personId, name, email) {
      if (done.has(personId)) return [];
      done.add(personId);
      all ??= Promise.all(books.map((b) => read(b))).then((lists) => lists.flatMap((l) => l ?? []));
      const contacts = await all;
      const person = await get(personId);
      if (!person || !contacts.length) return [];
      const c = matchContact(contacts, { name: person.name || name, email: person.email || email });
      if (!c) return [];
      const add = contactFill(person, c);
      const added = Object.entries(add).filter(([, v]) => v).map(([k]) => k);
      if (!added.length) return [];
      await save({
        id: personId,
        phone: add.phone,
        birthday: add.birthday,
        organisation_id: add.organisation ? await organisation(add.organisation) : undefined,
      });
      return added;
    },
  };
}
