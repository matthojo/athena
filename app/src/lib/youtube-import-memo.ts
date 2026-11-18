/**
 * When an account last imported a file (YouTube watch history, a Goodreads
 * library), so its page can say so. The server keeps it per account (the
 * import routes' `last_import`), so every device shows the same date; this
 * device keeps a copy in localStorage only so the line shows before the
 * server answers.
 */
import { request } from "../db/api";

const KEY = (id: string) => `athena.ytimport.${id}`;

export interface ImportMemo {
  at: string;
  /** Videos or books in the file. */
  items: number;
  days: number;
  /** Goodreads: of `items`, books to read. */
  to_read?: number;
}

/** What the server sends; `videos` is how this device stored it before the server did. */
type Stored = ImportMemo & { videos?: number };

export function rememberImport(id: string, memo: ImportMemo): void {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(memo));
  } catch {
    // Private mode or storage full: the line waits for the server.
  }
}

function cached(id: string): ImportMemo | null {
  try {
    const m = JSON.parse(localStorage.getItem(KEY(id)) ?? "null") as Stored | null;
    return m?.at ? { at: m.at, items: m.items ?? m.videos ?? 0, days: m.days ?? 0, to_read: m.to_read } : null;
  } catch {
    return null;
  }
}

/** What the account page says: "Imported 7 November" and "39,251 videos". */
export interface ImportLine {
  when: string;
  count: string;
}

function line(m: ImportMemo | null, unit: [string, string]): ImportLine | null {
  if (!m) return null;
  const at = new Date(m.at);
  if (Number.isNaN(at.getTime())) return null;
  const when = at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: at.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  const n = (x: number) => x.toLocaleString("en-GB");
  // "252 read, 36 to read" when part of a library is to-read books.
  const count = m.to_read ? `${n(m.items - m.to_read)} read, ${n(m.to_read)} to read` : `${n(m.items)} ${m.items === 1 ? unit[0] : unit[1]}`;
  return { when: `Imported ${when}`, count };
}

/** From this device's copy: shown straight away. `unit` is [one, many]. */
export function lastImportTitle(id: string, unit: [string, string] = ["video", "videos"]): ImportLine | null {
  return line(cached(id), unit);
}

/**
 * From the server (`path` is the import's GET route): the copy is refreshed
 * to match, or cleared when the server has none. Undefined when the server
 * can't be reached, so the page keeps what it shows.
 */
export async function serverImportTitle(id: string, path: string, unit: [string, string] = ["video", "videos"]): Promise<ImportLine | null | undefined> {
  let m: ImportMemo | null;
  try {
    m = (await request<{ last_import?: ImportMemo | null }>(path)).last_import ?? null;
  } catch {
    return undefined;
  }
  try {
    if (m) localStorage.setItem(KEY(id), JSON.stringify(m));
    else localStorage.removeItem(KEY(id));
  } catch {
    // The line still shows; it just won't be there before the server next time.
  }
  return line(m, unit);
}
