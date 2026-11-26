// A stand-in for Athena's /api/saved, for the end-to-end test and for trying
// the extension by hand (npm run mock). It follows netlify/lib/saved/routes.ts.

import { createServer } from "node:http";
import { Readable } from "node:stream";

export const KEY = "athc_e2eTestKey0123456789abcdef";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAEAIAAAB1mzrKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqCwgHNSEieE/XAAABE0lEQVR42u3byw2DMBBF0bH0KmJlqgkr6gYpdWSycBF34XsqsITmazOO476/3xIkPcfTF32MfaXneH8XfYx9GQGw1KzHCOCkT1MQaaWgD32MfVmEYek5rAGglF0QyhQEcw6ApZ0DUClTECp9moJItqGw1QU5CWPsgmAWYZgRAHMOgLmKgLmMg6VP5wCSKQhmFwRzFQFLzfF6Kc9xDoBZhGEWYZhFGJbyaSLKFAQzBcHSc7xGAMf/A2BeysMswjCLMMxVBCzl00SUKQjmHADzPgCWMgWhTEEwizDMVQTMVQQs5dNElKsIWHqWKQhkFwRbTxMv+hj7MgJgfgCYqwjYigAnYYxPE2HOATCLMMwiDPNGDPYHRmXQNvaK/XEAAAAASUVORK5CYII=",
  "base64",
);

const TEST_PAGE = (origin) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes on slow software</title>
<style>body{font:17px/1.6 Georgia,serif;max-width:640px;margin:48px auto;padding:0 24px;color:#222;background:#fff}
@media (prefers-color-scheme: dark){body{background:#161616;color:#ddd} a{color:#8ab4f8}}
pre{font:inherit;white-space:pre-wrap}</style></head><body>
<h1>Notes on slow software</h1>
<pre id="quote">Good tools disappear.
	You notice them only when they’re gone — and then “all at once”.</pre>
<p>Read more in <a id="link" href="https://example.com/essay">the full essay</a>.</p>
<p><img id="img" src="${origin}/cat.png" width="64" height="64" alt="A small square"></p>
</body></html>`;

export function startMock({ port = 0 } = {}) {
  const items = [];
  const state = { down: false };
  let next = 1;

  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const cors = {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    };
    const reply = (status, body, headers = {}) => {
      const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
      res.writeHead(status, { ...cors, ...(isJson ? { "content-type": "application/json" } : {}), ...headers });
      res.end(isJson ? JSON.stringify(body) : body);
    };
    const url = new URL(req.url, origin);

    if (req.method === "OPTIONS") return reply(204, "");
    if (url.pathname === "/page") return reply(200, TEST_PAGE(origin), { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/cat.png") return reply(200, PNG, { "content-type": "image/png" });
    if (url.pathname === "/__items") return reply(200, items);
    if (url.pathname === "/__down") {
      state.down = url.searchParams.get("v") !== "0";
      return reply(200, { down: state.down });
    }
    if (url.pathname === "/") return reply(200, "<!doctype html><title>Athena</title><p>Athena</p>", { "content-type": "text/html" });
    if (!url.pathname.startsWith("/api/saved")) return reply(404, { error: "Not found" });
    if (state.down) return reply(503, { error: "Down for a moment" });
    if (req.headers.authorization !== `Bearer ${KEY}`) return reply(401, { error: "Unauthorised" });

    if (req.method === "GET" && url.pathname === "/api/saved/ping") return reply(200, { ok: true, name: "Athena" });

    if (req.method === "POST" && url.pathname === "/api/saved") {
      const request = new Request(`${origin}${req.url}`, {
        method: "POST",
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: "half",
      });
      const type = req.headers["content-type"] || "";
      const fields = {};
      let image = null;
      if (type.startsWith("multipart/form-data")) {
        const form = await request.formData();
        for (const [k, v] of form) {
          if (typeof v === "string") fields[k] = v;
          else image = { name: v.name, type: v.type, size: v.size };
        }
      } else {
        Object.assign(fields, await request.json());
      }
      const answer = (status, item) => reply(status, { id: item.id, url: `${origin}/#/saved/${item.id}`, item });
      const dupe = items.find((i) => fields.client_id && i.client_id === fields.client_id);
      if (dupe) {
        if (fields.note) dupe.note = fields.note; // Saved: the note replaces the old one
        return answer(200, dupe);
      }
      const item = { id: String(next++), ...fields, image, multipart: Boolean(image) };
      items.push(item);
      return answer(201, item);
    }

    return reply(405, { error: "Method not allowed" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, items, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMock({ port: Number(process.env.PORT || 8787) });
  console.log(`Mock Athena at ${mock.origin}  key ${KEY}  test page ${mock.origin}/page`);
}
