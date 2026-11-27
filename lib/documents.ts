/**
 * Sending a note out: a new Google Doc in an "Athena" folder, or a new
 * Notion page under the parent the owner picked. Every doc and page made
 * is kept in document_exports (migration 0047), and that list is the only
 * thing Athena may change later: send the note again to update it, or Undo
 * to trash the doc or move the page under "Removed by Athena".
 *
 * The providers are reached through ports (DocumentPorts), so lib/ stays
 * free of the connector clients: netlify/lib/connectors/documents-port.ts is
 * the real one, which checks every request against documents-rules.ts.
 * Tests pass their own.
 */
import { calloutsAsQuotes } from "./callouts";
import { AthenaInputError, getNote, q, sealer } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { listConnectors } from "./connectors";
import { notionId, REMOVED_PAGE_TITLE } from "./documents-rules";

export type DocumentProvider = "google-docs" | "notion";

export interface DocumentExport {
  id: string;
  note_id: string | null;
  provider: DocumentProvider;
  connector_id: string;
  external_id: string;
  url: string;
  title: string;
  created_at: string;
  updated_at: string;
  undone_at: string | null;
}

export interface DocumentPorts {
  google: {
    /** Make the folder if it's missing (folderId null or gone), then a doc in it with this content. */
    create(connectorId: string, input: { title: string; markdown: string; folderId: string | null; owned: Set<string> }): Promise<{ id: string; url: string; folderId: string; folderMade: boolean }>;
    /** Replace a doc's content (a doc Athena made). */
    replace(connectorId: string, input: { id: string; title: string; markdown: string; owned: Set<string> }): Promise<void>;
    /** Trash it (Undo) or take it back out. */
    trash(connectorId: string, input: { id: string; trashed: boolean; owned: Set<string> }): Promise<void>;
  };
  notion: {
    create(connectorId: string, input: { parentId: string; title: string; markdown: string }): Promise<{ id: string; url: string }>;
    /** Undo: move a page Athena made under "Removed by Athena" (made under the parent the first time). */
    remove(connectorId: string, input: { id: string; parentId: string; removedId: string | null; own: Set<string> }): Promise<{ removedId: string; made: boolean }>;
    /** Rewrite a page Athena made: its title and content. */
    rewrite(connectorId: string, input: { id: string; title: string; markdown: string; own: Set<string>; parentId: string }): Promise<void>;
    /** Pages the account can see, for the parent picker. */
    search(connectorId: string, query: string): Promise<Array<{ id: string; title: string; url: string }>>;
  };
}

let defaultPorts: DocumentPorts | null = null;
/** The real ports, loaded on first use (the server's), or the ones a test sets. */
export async function documentPorts(): Promise<DocumentPorts> {
  if (!defaultPorts) defaultPorts = (await import("../netlify/lib/connectors/documents-port")).documentPorts;
  return defaultPorts;
}
export function setDocumentPorts(ports: DocumentPorts | null): void {
  defaultPorts = ports;
}

const COLS = `id, note_id, provider, connector_id, external_id, url, title, created_at, updated_at, undone_at`;

/** Where a note can go: connected Google Docs accounts, and Notion accounts with "Let Athena create pages" on. */
export interface DocumentAccount {
  id: string;
  provider: DocumentProvider;
  name: string;
  label: string;
  /** Notion: the page new ones go under. */
  parent_title?: string;
}

export async function documentAccounts(): Promise<DocumentAccount[]> {
  const all = await listConnectors();
  const parents = await notionParents();
  const out: DocumentAccount[] = [];
  for (const c of all) {
    if (c.status !== "connected" && c.status !== "pending") continue;
    if (c.provider === "google-docs") out.push({ id: c.id, provider: "google-docs", name: c.name, label: c.account_label });
    const parent = parents.get(c.id);
    if (c.provider === "notion" && parent?.id) out.push({ id: c.id, provider: "notion", name: c.name, label: c.account_label, parent_title: parent.title });
  }
  return out;
}

async function notionParents(): Promise<Map<string, { id: string | null; title: string }>> {
  const rows = await q<{ id: string; write_parent_id: string | null; write_parent_title: string }>(`SELECT id, write_parent_id, write_parent_title FROM connectors WHERE provider = 'notion'`);
  return new Map(rows.map((r) => [r.id, { id: r.write_parent_id, title: r.write_parent_title }]));
}

/** Notion: whether Athena may create pages, and under which page. */
export async function notionWriteState(connectorId: string): Promise<{ enabled: boolean; parent: { id: string; title: string } | null }> {
  const p = (await notionParents()).get(connectorId);
  if (!p) throw new AthenaInputError("That isn't a Notion account");
  return p.id ? { enabled: true, parent: { id: p.id, title: p.title } } : { enabled: false, parent: null };
}

/** Turn "Let Athena create pages" on (with the parent page picked) or off (null). */
export async function setNotionParent(connectorId: string, parent: { id: string; title: string } | null): Promise<{ enabled: boolean; parent: { id: string; title: string } | null }> {
  const id = parent ? notionId(parent.id) : null;
  if (parent && !id) throw new AthenaInputError("That isn't a Notion page");
  const title = parent ? parent.title.trim().slice(0, 200) || "Untitled" : "";
  const s = await sealer();
  const rows = await q<{ id: string }>(`UPDATE connectors SET write_parent_id = $2, write_parent_title = $3, updated_at = now() WHERE id = $1 AND provider = 'notion' RETURNING id`, [
    connectorId,
    id,
    s.text(title),
  ]);
  if (!rows.length) throw new AthenaInputError("That isn't a Notion account");
  return id ? { enabled: true, parent: { id, title } } : { enabled: false, parent: null };
}

export async function listExports(noteId: string): Promise<DocumentExport[]> {
  return q<DocumentExport>(`SELECT ${COLS} FROM document_exports WHERE note_id = $1 AND kind <> 'folder' ORDER BY created_at DESC`, [noteId]);
}

/** Every external id Athena made in this account: the only ones it may change. */
export async function ownedIds(connectorId: string): Promise<Set<string>> {
  const rows = await q<{ external_id: string }>(`SELECT external_id FROM document_exports WHERE connector_id = $1`, [connectorId]);
  return new Set(rows.map((r) => r.external_id));
}

async function pickAccount(to: DocumentProvider, connectorId?: string): Promise<DocumentAccount> {
  const accounts = (await documentAccounts()).filter((a) => a.provider === to);
  const account = connectorId ? accounts.find((a) => a.id === connectorId) : accounts[0];
  if (!account) {
    throw new AthenaInputError(
      to === "google-docs" ? "Add a Google Docs account in Sources first" : "Turn on “Let Athena create pages” for a Notion account in Sources first",
    );
  }
  return account;
}

/** athena:// links mean nothing outside Athena: their labels stay, the links go. Callouts become quotes (lib/callouts.ts). */
export function outsideMarkdown(md: string): string {
  return calloutsAsQuotes(md).replace(/\[@?((?:\\.|[^\]\\\n])*)\]\(athena:\/\/[a-z]+\/[0-9a-f-]{36}(?:\s+"[^"]*")?\)/gi, (_m, label: string) => label.replace(/\\(.)/g, "$1"));
}

export interface SendResult {
  export: DocumentExport;
  /** The note had been sent to this account before: that doc or page was updated instead of making another. */
  updated: boolean;
  account: DocumentAccount;
}

/** Send a note: a new doc or page, or an update of the one made from it last time (unless that was undone). */
export async function sendNote(noteId: string, to: DocumentProvider, opts: { connectorId?: string; ports?: DocumentPorts } = {}): Promise<SendResult> {
  const note = await getNote(noteId);
  if (!note) throw new AthenaInputError("No such note");
  if (isEncryptedPlaceholder(note.title) || isEncryptedPlaceholder(note.body)) throw new AthenaInputError("That note can't be read right now, so it can't be sent");
  const account = await pickAccount(to, opts.connectorId);
  const ports = opts.ports ?? (await documentPorts());
  const title = note.title.trim() || "Untitled";
  const markdown = outsideMarkdown(note.body);
  const s = await sealer();
  const [previous] = await q<DocumentExport>(
    `SELECT ${COLS} FROM document_exports WHERE note_id = $1 AND connector_id = $2 AND kind <> 'folder' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [noteId, account.id],
  );
  const owned = await ownedIds(account.id);

  if (previous) {
    if (to === "google-docs") await ports.google.replace(account.id, { id: previous.external_id, title, markdown, owned });
    else await ports.notion.rewrite(account.id, { id: previous.external_id, title, markdown, own: owned, parentId: (await notionWriteState(account.id)).parent!.id });
    const [row] = await q<DocumentExport>(`UPDATE document_exports SET title = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [previous.id, s.text(title)]);
    return { export: row, updated: true, account };
  }

  let made: { id: string; url: string };
  if (to === "google-docs") {
    const [folder] = await q<{ external_id: string }>(`SELECT external_id FROM document_exports WHERE connector_id = $1 AND kind = 'folder' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1`, [account.id]);
    const r = await ports.google.create(account.id, { title, markdown, folderId: folder?.external_id ?? null, owned });
    if (r.folderMade) {
      await q(
        `INSERT INTO document_exports (provider, connector_id, kind, external_id, title) VALUES ('google-docs', $1, 'folder', $2, $3) ON CONFLICT (connector_id, external_id) DO NOTHING`,
        [account.id, r.folderId, s.text("Athena")],
      );
    }
    made = r;
  } else {
    const state = await notionWriteState(account.id);
    made = await ports.notion.create(account.id, { parentId: state.parent!.id, title, markdown });
  }
  const [row] = await q<DocumentExport>(
    `INSERT INTO document_exports (note_id, provider, connector_id, kind, external_id, url, title) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (connector_id, external_id) DO UPDATE SET note_id = EXCLUDED.note_id, url = EXCLUDED.url, title = EXCLUDED.title, undone_at = NULL, updated_at = now()
     RETURNING ${COLS}`,
    [noteId, to, account.id, to === "google-docs" ? "doc" : "page", made.id, made.url, s.text(title)],
  );
  return { export: row, updated: false, account };
}

/**
 * Undo a send: trash the Google Doc, or move the Notion page under a
 * "Removed by Athena" page beside it (Notion's server has no way to archive
 * a page). Only for a row in document_exports,
 * so only for something Athena made.
 */
export async function undoExport(id: string, opts: { ports?: DocumentPorts } = {}): Promise<DocumentExport> {
  const [row] = await q<DocumentExport>(`SELECT ${COLS} FROM document_exports WHERE id = $1 AND kind <> 'folder'`, [id]);
  if (!row) throw new AthenaInputError("Athena didn't make that");
  if (row.undone_at) return row;
  const ports = opts.ports ?? (await documentPorts());
  const owned = await ownedIds(row.connector_id);
  if (row.provider === "google-docs") await ports.google.trash(row.connector_id, { id: row.external_id, trashed: true, owned });
  else {
    const state = await notionWriteState(row.connector_id);
    if (!state.parent) throw new AthenaInputError("Turn on “Let Athena create pages” again to undo this");
    const [removed] = await q<{ external_id: string }>(
      `SELECT external_id FROM document_exports WHERE connector_id = $1 AND provider = 'notion' AND kind = 'folder' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [row.connector_id],
    );
    const r = await ports.notion.remove(row.connector_id, { id: row.external_id, parentId: state.parent.id, removedId: removed?.external_id ?? null, own: owned });
    if (r.made) {
      const s = await sealer();
      await q(
        `INSERT INTO document_exports (provider, connector_id, kind, external_id, url, title) VALUES ('notion', $1, 'folder', $2, $3, $4) ON CONFLICT (connector_id, external_id) DO NOTHING`,
        [row.connector_id, r.removedId, `https://www.notion.so/${r.removedId}`, s.text(REMOVED_PAGE_TITLE)],
      );
    }
  }
  const [done] = await q<DocumentExport>(`UPDATE document_exports SET undone_at = now(), updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id]);
  return done;
}

/** "Google Docs", "Notion": for receipts. */
export const PROVIDER_NAME: Record<DocumentProvider, string> = { "google-docs": "Google Docs", notion: "Notion" };

export function isDocumentProvider(v: unknown): v is DocumentProvider {
  return v === "google-docs" || v === "notion";
}

