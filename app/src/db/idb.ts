/**
 * Hand-rolled IndexedDB wrapper for Athena.
 *
 * Called by: sync.ts (flush/pull), api.ts (local keyword-search fallback),
 * views/dashboard.ts and views/capture.ts (read-through cache for notes,
 * metrics, people so the UI never shows a blank screen offline).
 *
 * No npm dependency (no `idb` package) — this repo's package.json install is
 * not guaranteed to have network access when this runs, and the wrapper
 * surface we need (a handful of get/put/getAll/delete calls across a few
 * stores) is small enough that hand-rolling it is less risk than adding a
 * dependency mid-build.
 *
 * Sample mode keeps its notes and edits in a database of its own
 * ("athena-sample"), so they never sit beside the real cache.
 *
 * Schema (db "athena", version 2):
 *  - notes   (keyPath "id")       local cache of Note, newest-first via index
 *  - outbox  (autoIncrement "key") queued writes made offline, replayed on sync
 *  - meta    (keyPath "key")      small key/value store: lastSyncAt, etc.
 *  - metrics (keyPath "metric")   last-known points per metric, for offline charts
 *  - people  (keyPath "id")       last-known people list, for the nudge list
 *  - ask_threads (keyPath "id")   Ask's chats, with a `dirty`/`deleted` mark until synced (version 2)
 */

const DB_NAME = "athena";
const SAMPLE_DB_NAME = "athena-sample";
const DB_VERSION = 2;

/** Read here, not from api.ts (which imports this file): the mode flag api.ts keeps. */
function dbName(): string {
  try {
    return localStorage.getItem("athena.mode") === "sample" ? SAMPLE_DB_NAME : DB_NAME;
  } catch {
    return DB_NAME;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;
let openName = "";

function openDb(): Promise<IDBDatabase> {
  const name = dbName();
  if (dbPromise && openName === name) return dbPromise;
  // The mode changed under an open database (Connect → sample data): close the other one.
  void dbPromise?.then((db) => db.close()).catch(() => undefined);
  openName = name;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("notes")) {
        const notes = db.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("updated_at", "updated_at");
      }
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "key", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("metrics")) {
        db.createObjectStore("metrics", { keyPath: "metric" });
      }
      if (!db.objectStoreNames.contains("people")) {
        db.createObjectStore("people", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("ask_threads")) {
        db.createObjectStore("ask_threads", { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      // A newer build in another tab is upgrading: step aside so it isn't blocked (reopened on next use).
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(
  storeName: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let result: T;
    Promise.resolve(fn(t))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Sign out: delete the offline database, and sample mode's. Resolves once
 * each delete has finished or been queued behind another tab (which closes
 * its connection on `versionchange`, above).
 */
export async function deleteDatabases(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  await open?.then((db) => db.close()).catch(() => undefined);
  await Promise.all(
    [DB_NAME, SAMPLE_DB_NAME].map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        })
    )
  );
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Generic store helpers ----------

export async function putAll<T>(store: string, items: T[]): Promise<void> {
  if (!items.length) return;
  await tx(store, "readwrite", (t) => {
    const os = t.objectStore(store);
    for (const item of items) os.put(item as unknown);
  });
}

export async function put<T>(store: string, item: T): Promise<void> {
  await tx(store, "readwrite", (t) => {
    t.objectStore(store).put(item as unknown);
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  return tx(store, "readonly", (t) => reqToPromise(t.objectStore(store).getAll() as IDBRequest<T[]>));
}

export async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return tx(store, "readonly", (t) => reqToPromise(t.objectStore(store).get(key) as IDBRequest<T>));
}

export async function del(store: string, key: IDBValidKey): Promise<void> {
  await tx(store, "readwrite", (t) => {
    t.objectStore(store).delete(key);
  });
}

// ---------- meta (small KV) ----------

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await get<{ key: string; value: string }>("meta", key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await put("meta", { key, value });
}
