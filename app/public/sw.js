/**
 * Athena service worker — caches the app shell for offline load.
 *
 * Registered from src/main.ts on window "load". Strategy:
 *  - Install: precache "/" and "/manifest.json", then parse the cached HTML
 *    for its hashed Vite build assets (/assets/*.js, /assets/*.css) and
 *    precache those too, following the chunks each JS file names (every
 *    view but Home is its own lazy chunk, and the editor). Vite fingerprints
 *    filenames per build, so there's no fixed list to hardcode here (no
 *    vite-plugin-pwa in this project) — discovering them from the live
 *    index.html is what makes the very first offline visit after install
 *    actually work, instead of depending on a prior online page view having
 *    opportunistically warmed the runtime cache for every asset.
 *  - Navigations: network-first, falling back to the cached shell so a
 *    reload while offline still renders the app instead of a browser error
 *    page (netlify.toml's SPA redirect does the equivalent when online).
 *    When a navigation brings a new build (a deploy), its chunks are cached
 *    first and only then does its page become the offline shell, so the
 *    cached page never names chunks that aren't here; the old build's files
 *    are then cleared out.
 *  - Other same-origin GETs: cache-first. Build files (/assets/) are
 *    fingerprinted, so a cached one is never stale; the rest (icons, fonts,
 *    manifest) are refreshed in the background for next time. Only real
 *    files are cached: never the sign-in page or the SPA fallback that a
 *    gated or missing file gets instead.
 *  - `/api/*`: never intercepted. The app's own IndexedDB cache + sample
 *    data (see src/db/sync.ts, src/db/sample-data.ts) already handle the
 *    offline/unreachable-backend case; the service worker staying out of the
 *    way keeps auth headers and fresh responses simple.
 */

const CACHE_NAME = "athena-shell-v6";
const SHELL_PATHS = [
  "/",
  "/manifest.json",
  "/fonts/geist-latin.woff2",
  "/fonts/geist-latin-ext.woff2",
  "/fonts/funnel-display-latin.woff2",
  "/fonts/funnel-display-latin-ext.woff2",
];

/** The build files a page loads directly: its entry script and stylesheet. */
const assetsIn = (html) => Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (m) => m[1]);

/** Chunks a JS file names: `import("./notes-<hash>.js")`, preload lists ("assets/<file>"). */
const CHUNK_REF = /["'](?:\.\/|\/?assets\/)([\w.-]+-[\w-]{8}\.(?:js|css))["']/g;

/** A real file, not the sign-in page or the SPA fallback (index.html) a gated or missing file gets. */
const isFile = (res) => res.ok && !res.redirected && !(res.headers.get("content-type") || "").includes("text/html");

/**
 * Cache a build: the given files plus every chunk they name, recursively
 * (lazy views, the editor). Files already cached are read from the cache.
 * Resolves to the set of the build's files if every one is now cached, or
 * null if any couldn't be fetched (best effort — the rest are kept).
 */
async function cacheBuild(cache, entry) {
  const seen = new Set(entry);
  let complete = true;
  const visit = async (path) => {
    try {
      let res = await cache.match(path);
      if (!res) {
        res = await fetch(path);
        if (!isFile(res)) throw new Error(`${path}: ${res.status}`);
        await cache.put(path, res.clone());
      }
      if (!path.endsWith(".js")) return;
      const found = [];
      for (const m of (await res.text()).matchAll(CHUNK_REF)) {
        const chunk = `/assets/${m[1]}`;
        if (!seen.has(chunk)) {
          seen.add(chunk);
          found.push(chunk);
        }
      }
      await Promise.all(found.map(visit));
    } catch {
      complete = false;
    }
  };
  await Promise.all(entry.map(visit));
  return complete ? seen : null;
}

/** Drop build files (JS/CSS under /assets/) that aren't part of `keep`, i.e. older builds'. */
async function pruneBuilds(cache, keep) {
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && /\.(?:js|css)$/.test(path) && !keep.has(path)) await cache.delete(req);
  }
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(SHELL_PATHS);

  // Discover this build's hashed asset filenames from the shell HTML itself.
  // Best effort: offline at install time (e.g. first install with no
  // connectivity), the shell paths above are still cached and the rest fill
  // in at runtime (the app fetches every view's chunk once it's up).
  try {
    const shell = await cache.match("/");
    if (shell) await cacheBuild(cache, assetsIn(await shell.text()));
  } catch {
    // see above
  }
}

/**
 * Keep a fresh navigation response as the offline shell. The same build just
 * replaces the copy (as before). A new build's chunks are cached first, and
 * its page only replaces the copy once they all are; then the old build's
 * files go. If the connection drops part-way, the old copy (whose chunks are
 * all here) stays until the next visit tries again.
 */
async function keepShell(res) {
  const cache = await caches.open(CACHE_NAME);
  const assets = assetsIn(await res.clone().text());
  // Not the app (e.g. the sign-in page): store it as before.
  if (!assets.length) return cache.put("/", res);
  const cached = await cache.match("/");
  const cachedAssets = cached ? assetsIn(await cached.text()) : [];
  const sameBuild = cachedAssets.length === assets.length && assets.every((a) => cachedAssets.includes(a));
  if (sameBuild) return cache.put("/", res);
  const files = await cacheBuild(cache, assets);
  if (!files && cachedAssets.length) return;
  await cache.put("/", res);
  if (files) await pruneBuilds(cache, files);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * Who sent a POST to /share-target. A share from the OS has no initiating
 * site: `Sec-Fetch-Site: none` (`same-origin` is the app itself) is "os",
 * saved at once; any other value is a web page posting a form here: "site",
 * refused. Chromium adds Sec-Fetch-Site after the worker, so the worker never
 * sees it there; what it does see on every form POST is `Origin`, so another
 * origin (or "null") is refused the same way. With neither header there is
 * nothing to go on: "unknown", kept, and the app asks before saving
 * (views/saved.ts).
 */
const shareFrom = (req) => {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site) return site === "none" || site === "same-origin" ? "os" : "site";
  const origin = req.headers.get("Origin");
  if (origin) return origin === self.location.origin ? "os" : "site";
  return "unknown";
};

/** A shared assistant, skill or flow (a zip or its file), at most this big: the Add screen reads it (src/add/). */
const MAX_IMPORT_BYTES = 2_000_000;

/**
 * The shared title, text, link and first image, in Cache Storage until the app takes them.
 * A shared item (a .zip, or its assistant.json, SKILL.md or flow.json) is kept apart and opens #/add instead,
 * which shows all of it before anything is added.
 */
async function keepShare(req) {
  const from = shareFrom(req);
  // Another site's form: nothing is kept, and the app says there was nothing to save.
  if (from === "site") return Response.redirect("/#/saved/shared", 303);
  try {
    const form = await req.formData();
    const shared = form.getAll("assistant").find((f) => typeof f !== "string" && f.size > 0 && f.size <= MAX_IMPORT_BYTES);
    if (shared) {
      const cache = await caches.open("athena-share");
      await cache.put("/share-target/assistant", new Response(shared, { headers: { "Content-Type": shared.type || "application/octet-stream", "X-File-Name": encodeURIComponent(shared.name || "assistant.zip") } }));
      return Response.redirect("/#/add", 303);
    }
    const pick = (k) => (typeof form.get(k) === "string" ? form.get(k).slice(0, 20000) : "");
    const cache = await caches.open("athena-share");
    await cache.put("/share-target/meta", new Response(JSON.stringify({ title: pick("title"), text: pick("text"), url: pick("url"), trusted: from === "os" }), { headers: { "Content-Type": "application/json" } }));
    const file = form.getAll("image").find((f) => typeof f !== "string" && f.size > 0);
    if (file) await cache.put("/share-target/file", new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } }));
    else await cache.delete("/share-target/file");
  } catch {
    // Nothing kept: the page says there was nothing to save.
  }
  return Response.redirect("/#/saved/shared", 303);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // The installed app as a share target (manifest.json share_target): keep what was shared, then open
  // #/saved/shared, which sends it to /api/saved with the app's key and says "Saved" (views/saved.ts),
  // or, for a shared assistant, skill or flow, #/add, which previews it before anything is added.
  // Only a share from the OS is saved at once; see shareFrom.
  if (req.method === "POST" && url.origin === self.location.origin && url.pathname === "/share-target") {
    event.respondWith(keepShare(req));
    return;
  }

  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // Sign out has just cleared the caches (src/db/sign-out.ts): don't keep the page it lands on.
  if (url.pathname === "/logout") return;

  if (req.mode === "navigate") {
    const fresh = fetch(req).then((res) => ({ res, copy: res.clone() }));
    event.respondWith(fresh.then(({ res }) => res, async () => (await caches.match("/")) || (await caches.match(req)) || Response.error()));
    event.waitUntil(fresh.then(({ copy }) => keepShell(copy)).catch(() => {}));
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Cache-first for instant response. Build files never change under
        // their name; refresh anything else in the background.
        if (!url.pathname.startsWith("/assets/")) {
          fetch(req)
            .then((res) => {
              if (isFile(res)) caches.open(CACHE_NAME).then((cache) => cache.put(req, res));
            })
            .catch(() => {});
        }
        return cached;
      }
      return fetch(req).then((res) => {
        if (isFile(res)) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
      // No cache + network failure: let the fetch rejection propagate as a
      // normal network error rather than resolving to an invalid response.
    })
  );
});

// ---------- Notifications (Web Push) ----------
// Payloads come from lib/push.ts: { title, body, url, tag }. `url` is an
// in-app hash route (#/notes/<id>, #/days/<date>?mood); anything else is
// ignored so a notification can never send the app somewhere off-site.
// iOS shows no action buttons on web notifications, so a tap is the only
// action: it opens `url`. The app badge counts what's waiting; the app
// clears it when it opens (main.ts).

const safeRoute = (url) => (typeof url === "string" && url.startsWith("/#/") ? url : "/#/");

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Athena";
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: typeof data.body === "string" ? data.body : "",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: safeRoute(data.url) },
      })
      .then(() => self.registration.getNotifications())
      .then((shown) => self.navigator.setAppBadge?.(shown.length))
      .catch(() => {})
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = safeRoute(event.notification.data?.url);
  const url = new URL(route, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (!client) return self.clients.openWindow(url);
      await client.focus();
      // A window this worker controls changes route in place (main.ts listens),
      // keeping what's open; any other one loads the deep link.
      const controlled = (await self.clients.matchAll({ type: "window" })).some((c) => c.id === client.id);
      if (controlled) return client.postMessage({ type: "athena:navigate", url: route });
      return client.navigate ? client.navigate(url) : client.postMessage({ type: "athena:navigate", url: route });
    })
  );
});
