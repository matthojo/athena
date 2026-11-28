/**
 * On-demand Obsidian-compatible export of the full Athena dataset.
 *
 * Run via `npm run export:obsidian`. Writes a portable markdown vault to
 * `export/obsidian-vault/` (git-ignored — see .gitignore). This is a one-way,
 * on-demand snapshot, not a live sync: nothing reads this export back into
 * Athena.
 *
 * Deliberately does NOT import lib/db.ts. That file's `getDatabase()` relies
 * on @netlify/database's automatic environment detection, which only works
 * *inside* a Netlify Function. This script runs as a plain Node process
 * outside the Functions runtime, so it uses the second, explicitly-documented
 * Netlify DB access pattern instead: `getConnectionString()` paired with an
 * external `pg` client. See docs: security/netlify-db for why this is
 * the one place in the codebase allowed to do that.
 *
 * Notes in folders (note_folders, 0097) are written into folders of the same
 * names under notes/, three deep at most, so the vault keeps the owner's
 * filing; wikilinks still resolve, since a note's file name is unique across
 * the vault.
 *
 * Tables read: notes, note_folders, people, projects, places, organisations, events, edges,
 * and the owner's own kinds and their records (custom_kinds, custom_records:
 * one folder per kind, under types/) (see db/schema.sql). Archived items are skipped, like everywhere else
 * outside the app's Archived page. athena:// links in bodies are rewritten to
 * [[wikilinks]] so Obsidian's graph and backlinks work, in whatever mode
 * they're shown (Obsidian has no cards). Web links stay plain Markdown,
 * their mode kept in the link title (`[A walk](https://… "card")`), and a
 * link with no words of its own gets its page's title from the kept preview
 * (link_previews), else its site (exportLinks). Deliberately
 * skips sensitive_blobs — ciphertext has no business in a portable export, and
 * nothing here ever attempts to decrypt it.
 *
 * Content is encrypted at rest (docs: security/encryption), so the export opens it with
 * lib/data-box.ts, which needs the data key in this shell:
 *
 *   ATHENA_DATA_KEY="$(security find-generic-password -a athena -s ATHENA_DATA_KEY -w)" npm run export:obsidian
 *
 * Without it, encrypted fields come out as "Encrypted — open on …" and the
 * script says so. The vault it writes is plaintext: keep it somewhere safe.
 */
import { getConnectionString } from "@netlify/database";
import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blindIndexes, dataKeyConfigured, isSealed, openDeep } from "../lib/data-box";
import { formatWebLink, parseLinkMode, replaceAthenaLinks, unescapeLabel, webLinkRegex } from "../lib/links";
import { normalisePreviewUrl, previewKeyText } from "../lib/link-preview-url";
import { KIND_WORD } from "../lib/custom-kind-words";
import { isEncryptedPlaceholder } from "../lib/encrypted";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = path.join(__dirname, "..", "export", "obsidian-vault");

// ---------- Row shapes (matching db/schema.sql) ----------

interface NoteRow {
  id: string;
  title: string;
  body: string;
  type: string;
  source: string | null;
  tags: string[];
  folder_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
}

/** A folder's name as a directory: no path marks or characters a file system refuses, and never empty or hidden. */
function folderDirName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "").trim();
  return clean.slice(0, 80) || "Folder";
}

/** Each folder's directory under notes/, by id: "Work/Clients". A folder whose name can't be read here is left out (its notes go at the top). */
function folderDirs(folders: FolderRow[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const dirs = new Map<string, string>();
  for (const f of folders) {
    const parts: string[] = [];
    let at: FolderRow | undefined = f;
    let ok = true;
    while (at && parts.length <= 3) {
      if (isSealed(at.name) || isEncryptedPlaceholder(at.name)) ok = false;
      parts.unshift(folderDirName(at.name));
      at = at.parent_id ? byId.get(at.parent_id) : undefined;
    }
    if (ok) dirs.set(f.id, parts.join(path.sep));
  }
  return dirs;
}

interface PersonRow {
  id: string;
  name: string;
  notes: string;
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface PlaceRow {
  id: string;
  name: string;
  address: string;
  url: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface OrganisationRow {
  id: string;
  name: string;
  website: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  title: string;
  kind: string;
  date: string;
  time: string | null;
  /** UTC start of a timed one-off event (ISO). */
  starts_at: string | null;
  recurrence: string;
  year_known: boolean;
  notes: string;
  person_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One of the owner's own kinds of record ("Wines"), and a record in one. */
interface KindRow {
  id: string;
  name: string;
  one: string;
}

interface RecordRow {
  id: string;
  kind_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

type EntityType = "note" | "person" | "project" | "place" | "organisation" | "event" | "record";

/** One filled-in custom field (lib/custom-fields.ts): a record's own detail, like "Shoe size". */
interface CustomRow {
  entity_id: string;
  label: string;
  value: string;
}

interface EdgeRow {
  id: string;
  source_type: EntityType;
  source_id: string;
  target_type: EntityType;
  target_id: string;
  relation: string;
  created_at: string;
}

// ---------- Helpers ----------

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "untitled";
}

/** Makes a slug unique within its own folder by appending a short id suffix on collision. */
function uniqueSlug(desired: string, id: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  const withSuffix = `${desired}-${id.slice(0, 8)}`;
  used.add(withSuffix);
  return withSuffix;
}

/** YAML-safe scalar: JSON.stringify produces a valid double-quoted YAML string/array. */
function yamlValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function frontmatter(fields: Record<string, unknown>): string {
  // The owner's own field names ("Shoe size") are keys too: quote any that plain YAML wouldn't read.
  const lines = Object.entries(fields).map(([key, value]) => `${/^[\w][\w -]*$/.test(key) ? key : JSON.stringify(key)}: ${yamlValue(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

// ---------- Main ----------

/**
 * A body's links for the vault. Athena links become [[wikilinks]] (or the
 * plain label when the thing is archived or gone), in any mode. Web links
 * stay plain Markdown with their title: the mode, as Athena writes it
 * (`[A walk](https://… "card")`), so nothing about how a link was shown is
 * lost. A web link with no words of its own (an empty label, or the address
 * itself) gets the page's title when Athena kept one, else its site.
 */
export function exportLinks(markdown: string, names: ReadonlyMap<string, string>, pageTitle: (url: string) => string | null = () => null): string {
  const wiki = replaceAthenaLinks(markdown, (link) => {
    const name = names.get(`${link.kind}:${link.id}`);
    if (!name) return link.label;
    const label = link.label.replace(/^@/, "");
    return label === name ? `[[${name}]]` : `[[${name}|${label}]]`;
  });
  return wiki.replace(webLinkRegex(), (whole: string, rawLabel: string, url: string, dq?: string, sq?: string) => {
    const label = unescapeLabel(rawLabel).trim();
    const bare = !label || label === url || label === url.replace(/^https?:\/\//, "");
    const words = bare ? (pageTitle(url)?.trim() || siteLabel(url)) : label;
    try {
      return formatWebLink(url, words, parseLinkMode(dq ?? sq));
    } catch {
      return whole;
    }
  });
}

function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Titles of kept link previews for the web links in these bodies, by normalised address. Rows are found by blind index, as the server finds them. */
async function previewTitles(pool: pg.Pool, bodies: Array<string | null | undefined>): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const body of bodies) {
    for (const m of (body ?? "").matchAll(webLinkRegex())) {
      const url = normalisePreviewUrl(m[2]);
      if (url) for (const k of blindIndexes("other", previewKeyText(url))) byKey.set(k, url);
    }
  }
  const out = new Map<string, string>();
  if (!byKey.size) return out;
  try {
    const { rows } = await pool.query<{ url_bidx: string; title: string | null }>(
      "SELECT url_bidx, title FROM link_previews WHERE status = 'ok' AND url_bidx = ANY($1::text[])",
      [[...byKey.keys()]],
    );
    openDeep(rows as unknown[]);
    for (const r of rows) if (r.title && !isSealed(r.title)) out.set(byKey.get(r.url_bidx)!, r.title);
  } catch {
    // No link_previews table (an older database): links keep their site instead.
  }
  return out;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: getConnectionString() });

  try {
    const [notesResult, peopleResult, projectsResult, placesResult, orgsResult, eventsResult, edgesResult, customResult, kindsResult, recordsResult] =
      await Promise.all([
        pool.query<NoteRow>("SELECT * FROM notes WHERE archived_at IS NULL ORDER BY created_at ASC"),
        pool.query<PersonRow>("SELECT id, name, notes, last_contacted_at, created_at, updated_at FROM people WHERE archived_at IS NULL"),
        pool.query<ProjectRow>("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name ASC"),
        pool.query<PlaceRow>("SELECT * FROM places WHERE archived_at IS NULL ORDER BY name ASC"),
        pool.query<OrganisationRow>("SELECT * FROM organisations WHERE archived_at IS NULL ORDER BY name ASC"),
        // Cast date/time to text: pg would otherwise turn DATE into a local-midnight JS Date.
        pool.query<EventRow>(
          `SELECT id, title, kind, to_char(date, 'YYYY-MM-DD') AS date, to_char(time, 'HH24:MI') AS time,
                  to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at, recurrence, year_known, notes, person_id, created_at, updated_at
           FROM events WHERE archived_at IS NULL ORDER BY date ASC`,
        ),
        pool.query<EdgeRow>("SELECT * FROM edges ORDER BY created_at ASC"),
        // The owner's own fields, in their order (archived fields stay out, like archived records).
        pool.query<CustomRow>(
          `SELECT v.entity_id, f.label, v.value FROM custom_values v
           JOIN custom_fields f ON f.id = v.field_id AND f.archived_at IS NULL
           ORDER BY f.kind, f.position, f.created_at`,
        ),
        // Only live kinds, and only live records in them (an archived kind hides its records).
        pool.query<KindRow>("SELECT id, name, one FROM custom_kinds WHERE archived_at IS NULL ORDER BY position, created_at"),
        pool.query<RecordRow>(
          `SELECT r.id, r.kind_id, r.title, r.body, r.created_at, r.updated_at FROM custom_records r
           JOIN custom_kinds k ON k.id = r.kind_id AND k.archived_at IS NULL WHERE r.archived_at IS NULL ORDER BY r.created_at ASC`,
        ),
      ]);

    const results = [notesResult, peopleResult, projectsResult, placesResult, orgsResult, eventsResult, customResult, kindsResult, recordsResult];
    const encrypted = results.some((r) => r.rows.some((row) => Object.values(row).some(isSealed)));
    if (encrypted && !dataKeyConfigured()) {
      console.warn(
        "This data is encrypted and ATHENA_DATA_KEY isn't set here, so encrypted fields are exported as placeholders.\n" +
          'Run it as: ATHENA_DATA_KEY="$(security find-generic-password -a athena -s ATHENA_DATA_KEY -w)" npm run export:obsidian',
      );
    }
    for (const r of results) openDeep(r.rows as unknown[]);
    // Folders for notes (0097); an older database has none.
    let folders: FolderRow[] = [];
    try {
      folders = (await pool.query<FolderRow>("SELECT id, name, parent_id FROM note_folders")).rows;
      openDeep(folders as unknown[]);
    } catch {
      folders = [];
    }
    const dirs = folderDirs(folders);

    const notes = notesResult.rows;
    // Names are encrypted, so people are sorted here rather than in SQL.
    const people = peopleResult.rows.sort((a, b) => a.name.localeCompare(b.name));
    const projects = projectsResult.rows;
    const places = placesResult.rows;
    const organisations = orgsResult.rows;
    const events = eventsResult.rows;
    const edges = edgesResult.rows;
    const kinds = kindsResult.rows;
    const records = recordsResult.rows;

    // Each record's custom fields as frontmatter, after its own keys (never replacing one).
    const custom = new Map<string, Record<string, unknown>>();
    for (const row of customResult.rows) {
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        continue; // couldn't be decrypted here: left out rather than exported as a placeholder
      }
      custom.set(row.entity_id, { ...(custom.get(row.entity_id) ?? {}), [row.label]: value });
    }
    const withCustom = (id: string, fields: Record<string, unknown>) => ({
      ...fields,
      ...Object.fromEntries(Object.entries(custom.get(id) ?? {}).filter(([key]) => !(key in fields))),
    });

    for (const folder of ["notes", "people", "projects", "places", "organisations", "events"]) {
      await mkdir(path.join(VAULT_ROOT, folder), { recursive: true });
    }

    // Web links with no words of their own take their page's title from its kept preview, when there is one.
    const pageTitles = await previewTitles(pool, [
      ...notes.map((n) => n.body),
      ...people.map((p) => p.notes),
      ...projects.map((p) => p.description),
      ...places.map((p) => p.notes),
      ...organisations.map((o) => o.notes),
      ...events.map((e) => e.notes),
      ...records.map((r) => r.body),
    ]);

    // Lookup table so edges can resolve the *other* entity's display name,
    // regardless of which side of the edge it's on.
    const entityNames = new Map<string, string>(); // key: `${type}:${id}`
    for (const note of notes) entityNames.set(`note:${note.id}`, note.title);
    for (const person of people) entityNames.set(`person:${person.id}`, person.name);
    for (const project of projects) entityNames.set(`project:${project.id}`, project.name);
    for (const place of places) entityNames.set(`place:${place.id}`, place.name);
    for (const org of organisations) entityNames.set(`organisation:${org.id}`, org.name);
    for (const event of events) entityNames.set(`event:${event.id}`, event.title);
    for (const record of records) entityNames.set(`record:${record.id}`, record.title);

    /** athena://kind/id links -> [[Name]] (or the plain label if the target is archived/gone). */
    function toWikilinks(markdown: string): string {
      return exportLinks(markdown, entityNames, (url) => pageTitles.get(normalisePreviewUrl(url) ?? "") ?? null);
    }

    function linksSection(type: EntityType, id: string): string {
      const links = wikilinksFor(type, id);
      return links.length > 0 ? `\n\n## Links\n\n${links.map((l) => `- ${l}`).join("\n")}\n` : "";
    }

    function wikilinksFor(type: EntityType, id: string): string[] {
      const links: string[] = [];
      for (const edge of edges) {
        let otherType: EntityType | null = null;
        let otherId: string | null = null;
        if (edge.source_type === type && edge.source_id === id) {
          otherType = edge.target_type;
          otherId = edge.target_id;
        } else if (edge.target_type === type && edge.target_id === id) {
          otherType = edge.source_type;
          otherId = edge.source_id;
        }
        if (!otherType || !otherId) continue;
        const name = entityNames.get(`${otherType}:${otherId}`);
        if (name) links.push(`[[${name}]]`);
      }
      // de-dupe while preserving order
      return [...new Set(links)];
    }

    // Slugs are assigned per-folder so filenames stay stable and collision-free.
    const noteSlugs = new Set<string>();
    const peopleSlugs = new Set<string>();
    const projectSlugs = new Set<string>();

    for (const note of notes) {
      const slug = uniqueSlug(slugify(note.title), note.id, noteSlugs);
      const fm = frontmatter(withCustom(note.id, {
        id: note.id,
        type: note.type,
        source: note.source,
        tags: note.tags,
        created_at: note.created_at,
        updated_at: note.updated_at,
        aliases: [note.title],
      }));
      const links = wikilinksFor("note", note.id);
      const linksSection = links.length > 0 ? `\n\n## Links\n\n${links.map((l) => `- ${l}`).join("\n")}\n` : "";
      const content = `${fm}\n# ${note.title}\n\n${toWikilinks(note.body)}${linksSection}`;
      const dir = path.join(VAULT_ROOT, "notes", (note.folder_id && dirs.get(note.folder_id)) || "");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${slug}.md`), content, "utf8");
    }

    for (const person of people) {
      const slug = uniqueSlug(slugify(person.name), person.id, peopleSlugs);
      const fm = frontmatter(withCustom(person.id, {
        id: person.id,
        type: "person",
        last_contacted_at: person.last_contacted_at,
        created_at: person.created_at,
        updated_at: person.updated_at,
        aliases: [person.name],
      }));
      const links = wikilinksFor("person", person.id);
      const linksSection = links.length > 0 ? `\n\n## Links\n\n${links.map((l) => `- ${l}`).join("\n")}\n` : "";
      const content = `${fm}\n# ${person.name}\n\n${toWikilinks(person.notes)}${linksSection}`;
      await writeFile(path.join(VAULT_ROOT, "people", `${slug}.md`), content, "utf8");
    }

    // Projects aren't called out explicitly in the export spec, but edges can
    // target them, so they're exported too — otherwise a note's wikilink to a
    // project would point at a file that doesn't exist in the vault.
    for (const project of projects) {
      const slug = uniqueSlug(slugify(project.name), project.id, projectSlugs);
      const fm = frontmatter(withCustom(project.id, {
        id: project.id,
        type: "project",
        status: project.status,
        created_at: project.created_at,
        updated_at: project.updated_at,
        aliases: [project.name],
      }));
      const links = wikilinksFor("project", project.id);
      const linksSection = links.length > 0 ? `\n\n## Links\n\n${links.map((l) => `- ${l}`).join("\n")}\n` : "";
      const content = `${fm}\n# ${project.name}\n\n${toWikilinks(project.description)}${linksSection}`;
      await writeFile(path.join(VAULT_ROOT, "projects", `${slug}.md`), content, "utf8");
    }

    const placeSlugs = new Set<string>();
    for (const place of places) {
      const slug = uniqueSlug(slugify(place.name), place.id, placeSlugs);
      const fm = frontmatter(withCustom(place.id, {
        id: place.id,
        type: "place",
        address: place.address,
        url: place.url,
        created_at: place.created_at,
        updated_at: place.updated_at,
        aliases: [place.name],
      }));
      const content = `${fm}\n# ${place.name}\n\n${toWikilinks(place.notes)}${linksSection("place", place.id)}`;
      await writeFile(path.join(VAULT_ROOT, "places", `${slug}.md`), content, "utf8");
    }

    const orgSlugs = new Set<string>();
    for (const org of organisations) {
      const slug = uniqueSlug(slugify(org.name), org.id, orgSlugs);
      const fm = frontmatter(withCustom(org.id, {
        id: org.id,
        type: "organisation",
        website: org.website,
        created_at: org.created_at,
        updated_at: org.updated_at,
        aliases: [org.name],
      }));
      const content = `${fm}\n# ${org.name}\n\n${toWikilinks(org.notes)}${linksSection("organisation", org.id)}`;
      await writeFile(path.join(VAULT_ROOT, "organisations", `${slug}.md`), content, "utf8");
    }

    const eventSlugs = new Set<string>();
    for (const event of events) {
      const slug = uniqueSlug(slugify(event.title), event.id, eventSlugs);
      const fm = frontmatter(withCustom(event.id, {
        id: event.id,
        type: "event",
        kind: event.kind,
        // Year-unknown yearly dates carry a placeholder year; export them as --MM-DD.
        date: event.year_known ? event.date : `--${event.date.slice(5)}`,
        time: event.time,
        starts_at: event.starts_at,
        recurrence: event.recurrence,
        created_at: event.created_at,
        updated_at: event.updated_at,
        aliases: [event.title],
      }));
      const person = event.person_id ? entityNames.get(`person:${event.person_id}`) : undefined;
      const personLine = person ? `Person: [[${person}]]\n\n` : "";
      const content = `${fm}\n# ${event.title}\n\n${personLine}${toWikilinks(event.notes)}${linksSection("event", event.id)}`;
      await writeFile(path.join(VAULT_ROOT, "events", `${slug}.md`), content, "utf8");
    }

    // The owner's own kinds: a folder each (types/wines/), a file per record with its fields as frontmatter.
    const kindSlugs = new Set<string>();
    for (const kind of kinds) {
      const folder = path.join(VAULT_ROOT, KIND_WORD.many, uniqueSlug(slugify(kind.name), kind.id, kindSlugs));
      await mkdir(folder, { recursive: true });
      const recordSlugs = new Set<string>();
      for (const record of records.filter((r) => r.kind_id === kind.id)) {
        const slug = uniqueSlug(slugify(record.title), record.id, recordSlugs);
        const fm = frontmatter(withCustom(record.id, {
          id: record.id,
          type: kind.one,
          created_at: record.created_at,
          updated_at: record.updated_at,
          aliases: [record.title],
        }));
        const content = `${fm}
# ${record.title}

${toWikilinks(record.body)}${linksSection("record", record.id)}`;
        await writeFile(path.join(folder, `${slug}.md`), content, "utf8");
      }
    }

    console.log(
      `Exported ${notes.length} notes, ${people.length} people, ${projects.length} projects, ` +
        `${places.length} places, ${organisations.length} organisations, ${events.length} events, ` +
        `${records.length} records in ${kinds.length} ${KIND_WORD.many} to ${VAULT_ROOT}`,
    );
    console.log("Skipped sensitive_blobs (ciphertext is never included in exports).");
  } finally {
    await pool.end();
  }
}

// Run only as a script (npm run export:obsidian), not when a test imports exportLinks.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Obsidian export failed:", err);
    process.exitCode = 1;
  });
}
