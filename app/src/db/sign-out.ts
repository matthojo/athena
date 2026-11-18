/**
 * Sign out removes everything this browser holds: this device's key (on the
 * server too, so it stops working anywhere), the offline database, every athena-* cache, the push subscription and the
 * service worker. main.ts then goes to /logout, which clears the session
 * cookie. Unsent changes are counted first so main.ts can warn and offer to
 * send them.
 *
 * Each step is best effort and none stops the rest: a browser without Cache
 * Storage or a worker still loses its key and database.
 */

import { deletePushSubscription, removeOwnKey } from "./api";
import { deleteDatabases, getAll } from "./idb";

/** Changes made here that the server doesn't have yet: queued note writes and unsynced Ask chats. */
export async function unsentCount(): Promise<number> {
  const [outbox, threads] = await Promise.all([
    getAll<unknown>("outbox").catch(() => []),
    getAll<{ dirty?: boolean }>("ask_threads").catch(() => []),
  ]);
  return outbox.length + threads.filter((t) => t.dirty).length;
}

/** Try to send them (the same pass as "Sync now"); resolves to how many are still unsent. */
export async function sendUnsent(): Promise<number> {
  try {
    const [{ flushOutbox }, { pushThreads }] = await Promise.all([import("./sync"), import("./ask-threads")]);
    await flushOutbox();
    await pushThreads();
  } catch {
    // Offline: the count below says so.
  }
  return unsentCount();
}

/** What wipeDevice touches, so a test can stand in for the browser. */
export interface DeviceEnv {
  localStorage: Pick<Storage, "clear">;
  sessionStorage: Pick<Storage, "clear">;
  caches?: Pick<CacheStorage, "keys" | "delete">;
  serviceWorker?: { getRegistrations(): Promise<readonly Pick<ServiceWorkerRegistration, "unregister" | "pushManager">[]> };
  /** Tell the server to drop this push endpoint (needs the key, so it runs first). */
  forgetPush: (endpoint: string) => Promise<unknown>;
  /** Have the server remove this device's own key. The last call made with it. */
  removeKey: () => Promise<unknown>;
  deleteDatabases: () => Promise<void>;
}

const browserEnv = (): DeviceEnv => ({
  localStorage,
  sessionStorage,
  caches: typeof caches === "undefined" ? undefined : caches,
  serviceWorker: navigator.serviceWorker,
  forgetPush: deletePushSubscription,
  removeKey: removeOwnKey,
  deleteDatabases,
});

const quietly = async (step: () => Promise<unknown>) => {
  try {
    await step();
  } catch {
    // best effort; carry on with the rest
  }
};

/** No step waits on the network for longer than this. */
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]);

export async function wipeDevice(env: DeviceEnv = browserEnv()): Promise<void> {
  const registrations = (await env.serviceWorker?.getRegistrations().catch(() => [])) ?? [];

  // Push first: the server only drops the endpoint while the key is still here.
  for (const reg of registrations) {
    await quietly(async () => {
      const sub = await reg.pushManager?.getSubscription();
      if (!sub) return;
      await within(4000, env.forgetPush(sub.endpoint).catch(() => undefined));
      await sub.unsubscribe();
    });
  }

  // Then the key itself, on the server, while it's still held here.
  await quietly(() => within(4000, env.removeKey()));

  // The key, sample mode's flag, and everything else the app keeps here (drafts, names, import notes).
  await quietly(async () => env.localStorage.clear());
  await quietly(async () => env.sessionStorage.clear());

  await quietly(env.deleteDatabases);

  await quietly(async () => {
    if (!env.caches) return;
    const names = (await env.caches.keys()).filter((name) => name.startsWith("athena-"));
    await Promise.all(names.map((name) => env.caches!.delete(name)));
  });

  for (const reg of registrations) await quietly(() => reg.unregister());
}
