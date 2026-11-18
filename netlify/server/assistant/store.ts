/**
 * Where Ask's runs are kept so a new instance can answer for an old one's
 * (runs.ts): Netlify Blobs, one sealed record a run, under the day it
 * started. A record holds what the reply does: its steps, its words and the
 * reply itself, so it's sealed with ATHENA_DATA_KEY like the owner's files
 * (lib/data-box.ts sealBytes). Without a key nothing is written and runs
 * live in memory only. Records are deleted after their second day.
 */
import { getStore } from "@netlify/blobs";
import { dataKeyConfigured, openBytes, sealBytes } from "../../../lib/data-box";
import type { RunRecord, RunStore } from "./runs";

const STORE = "athena-ask-runs";
type Blobs = Pick<ReturnType<typeof getStore>, "get" | "set" | "delete" | "list">;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * Can this instance write, read back and delete in the store? Run once per instance and logged, so the
 * site's logs say whether runs can be kept. The probe holds nothing personal: the word "ok" under a random key.
 */
export async function probeBlobs(make: () => Blobs = () => getStore({ name: STORE, consistency: "strong" })): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  const key = `probe/${crypto.randomUUID()}`;
  const store = make();
  await store.set(key, "ok");
  const back = await store.get(key, { type: "text" });
  await store.delete(key);
  return { ok: back === "ok", ms: Date.now() - started };
}

export function blobRunStore(make: () => Blobs = () => getStore({ name: STORE, consistency: "strong" }), now: () => number = Date.now): RunStore | null {
  if (!dataKeyConfigured()) return null;
  /** Where each run seen by this instance is, so a write doesn't look for it. */
  const keys = new Map<string, string>();
  let tidied = 0;

  /** Once an hour at most: drop the days before yesterday. */
  async function tidy(): Promise<void> {
    if (now() - tidied < 3_600_000) return;
    tidied = now();
    const keep = new Set([day(now()), day(now() - DAY_MS)]);
    const store = make();
    const { blobs } = await store.list();
    await Promise.all(blobs.filter((b) => !keep.has(b.key.slice(0, 10))).map((b) => store.delete(b.key)));
  }

  return {
    async get(id) {
      const tries = keys.has(id) ? [keys.get(id)!] : [`${day(now())}/${id}`, `${day(now() - DAY_MS)}/${id}`];
      for (const key of tries) {
        const sealed = await make().get(key, { type: "arrayBuffer" });
        if (!sealed) continue;
        keys.set(id, key);
        return JSON.parse(openBytes(new Uint8Array(sealed)).toString("utf8")) as RunRecord;
      }
      return null;
    },
    async put(record) {
      const key = keys.get(record.id) ?? `${day(record.started)}/${record.id}`;
      keys.set(record.id, key);
      if (keys.size > 500) keys.delete(keys.keys().next().value!);
      const { sealed } = sealBytes(Buffer.from(JSON.stringify(record), "utf8"));
      await make().set(key, sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer);
      void tidy().catch(() => undefined);
    },
  };
}
