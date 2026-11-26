/**
 * The service worker keeps a navigation as the offline copy of "/" only when
 * it is the app: "/" itself, 200, not redirected. Runs app/public/sw.js itself.
 * Run: npx tsx --test app/src/db/sw-shell.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://athena.example";
const APP = `<!doctype html><script type="module" src="/assets/index-AbCd1234.js"></script>`;

function worker(answer: (url: string) => Response) {
  const shell = new Map<string, Response>();
  const caches = {
    open: async () => ({
      put: async (k: string, v: Response) => void shell.set(k, v),
      match: async (k: string) => shell.get(k)?.clone(),
      delete: async (k: string) => shell.delete(k),
      keys: async () => [...shell.keys()].map((k) => new Request(new URL(k, ORIGIN))),
    }),
    keys: async () => [],
    delete: async () => true,
    match: async (k: string) => shell.get(k)?.clone(),
  };
  const handlers: Record<string, (e: any) => void> = {};
  const self = { location: { origin: ORIGIN }, addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn), registration: {}, clients: {}, navigator: {}, skipWaiting() {} };
  const fetch = async (r: any) => answer(typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
  vm.runInNewContext(source, { self, caches, URL, Response, Request, Headers, fetch, JSON, Array, Promise, Set, Error });
  const navigate = async (path: string) => {
    const req = new Request(`${ORIGIN}${path}`);
    Object.defineProperty(req, "mode", { value: "navigate" });
    const waits: Promise<unknown>[] = [];
    let res: Promise<Response> | undefined;
    handlers.fetch({ request: req, respondWith: (r: Promise<Response>) => (res = r), waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await res;
    await Promise.all(waits);
  };
  const kept = async () => (shell.has("/") ? shell.get("/")!.clone().text() : null);
  return { navigate, kept };
}

const page = (body: string, init: ResponseInit = {}, redirected = false) => {
  const res = new Response(body, { status: 200, headers: { "Content-Type": "text/html" }, ...init });
  if (redirected) Object.defineProperty(res, "redirected", { value: true });
  return res;
};
const file = () => new Response("export {}", { headers: { "Content-Type": "text/javascript" } });

test("the app at / is kept as the offline shell", async () => {
  const w = worker((url) => (url.endsWith("/") ? page(APP) : file()));
  await w.navigate("/");
  assert.equal(await w.kept(), APP);
});

test("a redirect to the sign-in page isn't kept as /", async () => {
  const w = worker((url) => (url.endsWith("/") ? page("<form action=/login></form>", {}, true) : file()));
  await w.navigate("/");
  assert.equal(await w.kept(), null);
});

test("an error page isn't kept as /", async () => {
  const w = worker(() => page(APP, { status: 503 }));
  await w.navigate("/");
  assert.equal(await w.kept(), null);
});

test("another same-origin page isn't kept as /", async () => {
  const w = worker((url) => (url.includes("/share-target") ? page(APP) : file()));
  await w.navigate("/share-target");
  assert.equal(await w.kept(), null);
});

test("a page with no build files leaves the kept shell as it is", async () => {
  let body = APP;
  const w = worker((url) => (url.endsWith("/") ? page(body) : file()));
  await w.navigate("/");
  body = "<!doctype html><p>Something else</p>";
  await w.navigate("/");
  assert.equal(await w.kept(), APP);
});
