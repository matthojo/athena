// Real path: Recipes through the real /api function on Postgres with every migration. Recipe pages are
// served from a local server (the fixtures in lib/fixtures/recipes, their photos pointed at it), so the
// guarded fetch, Saved, the parser and sealing all run for real. Saved recipe links from before Recipes
// move in once (and only once); a link is imported, deduped by its canonical address, a page without a
// recipe offers Try harder (the model stubbed); a shared link lands in Recipes; the week is planned
// around a calendar (a stub port behind a connected account); the grocery list is built, merged, ticked
// and cleared; Ask's find_recipes answers on both back ends and import_recipe undoes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/recipes.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

import { parseIngredient } from "./recipe-units";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/recipes/${name}.html`, import.meta.url), "utf8");

test("recipes: Saved links move in once, links import and dedupe, the week is planned, the list is built", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 140, b: 60 } } }).jpeg().toBuffer();
  let base = "";
  const pages: Record<string, string> = {
    "/pie": "bbc-good-food",
    "/chasseur": "recipetin-eats",
    "/cookies": "bon-appetit",
    "/bread": "food-com",
    "/banana": "schema-org-microdata",
  };
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits.push(path);
    if (path === "/img.jpg") return void res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
    if (path === "/plain") return void res.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>Granny's soup</title></head><body><article><h1>Granny's soup</h1><p>Soften two leeks in butter. Add a potato and a litre of stock, simmer for 20 minutes, then blend.</p><p>It feeds four.</p></article></body></html>");
    const name = pages[path];
    if (!name) return void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Gone</h1>");
    // Photos point back here; canonical links keep the real sites' addresses, as the pages say.
    const html = fixture(name).replace(/https:\/\/[^"'\s]+?\.(?:jpe?g|png|webp)[^"'\s]*/gi, `${base}/img.jpg`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const { pageDeps } = await import("./saved-fetch");
    pageDeps.fetch = (input, init) => fetch(input, init);
    pageDeps.assertPublic = async () => undefined;
    pageDeps.upgrade = (u) => u;
    const blobs = new Map<string, Uint8Array>();
    const { useSavedStore, saveItem } = await import("./saved");
    useSavedStore(() => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, new Uint8Array(v)), get: async (k: string) => (blobs.has(k) ? blobs.get(k)!.buffer : null), delete: async (k: string) => void blobs.delete(k) }) as never);

    const api = (await import("../netlify/functions/api")).default;
    const { qRaw } = await import("./db");
    const { importDeps, getWeekPlan, mondayOf } = await import("./recipes");
    const { createConnector, setConnectorStatus } = await import("./connectors");
    const { runAssistantTool, applyUndo } = await import("./assistant");
    const { findRecipesJson } = await import("./assistant-recipes");
    const { zonedToday, addDays } = await import("./dates");

    // Trips and travel legs from other tests would make evenings travel ones.
    for (const t of ["grocery_items", "meal_plan", "recipe_cooked", "recipes", "edges", "saved_items", "trip_bookings", "trips"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM settings WHERE key = 'recipes'`);
    await qRaw(`DELETE FROM connectors WHERE provider = 'google-calendar'`);

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await api(
        new Request(`https://athena.test/api${path}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        {} as never,
      );
      return { status: res.status, body: (await res.json()) as any };
    };

    // ---- before Recipes: two recipe links in Saved, one whose page has since gone ----
    const chasseur = (await saveItem({ url: `${base}/chasseur`, source: "app" })).item;
    assert.equal(chasseur.thing, "recipe");
    const gone = (await saveItem({ url: `${base}/bread`, source: "app" })).item;
    // As they were before migration 0053: not filed, no recipes. /bread's page is gone now.
    await qRaw(`DELETE FROM recipes`);
    await qRaw(`UPDATE saved_items SET filed_at = NULL, filed_to = NULL`);
    delete pages["/bread"];

    const first = await call("GET", "/recipes");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.moved, 2);
    const titles = first.body.recipes.map((r: { title: string }) => r.title).sort();
    assert.deepEqual(titles, ["Best Banana Bread", "JB's Chicken Chasseur"], "the gone page moves as its Saved title");
    const jb = first.body.recipes.find((r: { title: string }) => r.title === "JB's Chicken Chasseur");
    assert.equal(jb.parse, "json-ld");
    assert.equal(jb.ingredient_count, 19);
    assert.equal(jb.total_minutes, 60);
    assert.match(jb.photo_url, new RegExp(`^/api/saved/${chasseur.id}/image$`), "the photo is Saved's sealed copy");
    const bread = first.body.recipes.find((r: { title: string }) => r.title === "Best Banana Bread");
    assert.equal(bread.parse, "manual");
    // Saved keeps both, filed in Recipes as pointers.
    const savedNow = await call("GET", `/saved/${chasseur.id}`);
    assert.deepEqual(savedNow.body.filed && { action: savedNow.body.filed.action, label: savedNow.body.filed.label, href: savedNow.body.filed.href }, { action: "recipe", label: "Recipes", href: `#/recipes/${jb.id}` });
    assert.equal((await call("GET", "/saved")).body.items.length, 0, "filed items leave Saved's main list");

    // Again: nothing moves. Put back in Saved: still nothing (the recipe points at it), and no copy.
    assert.equal((await call("GET", "/recipes")).body.moved, 0);
    const back = await call("POST", `/saved/${chasseur.id}/actions/undo`, {});
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.filed ?? null, null);
    const again = await call("GET", "/recipes");
    assert.equal(again.body.moved, 0);
    assert.equal(again.body.recipes.length, 2);
    const actions = await call("GET", `/saved/${chasseur.id}/actions`);
    assert.equal(actions.body.actions[0].id, "recipe", "Move to Recipes is the suggested action");
    const refile = await call("POST", `/saved/${chasseur.id}/actions/recipe`, {});
    assert.equal(refile.status, 200, JSON.stringify(refile.body));
    assert.equal(refile.body.result.done, "Already in Recipes");
    assert.equal((await qRaw<{ n: string }>(`SELECT count(*) AS n FROM recipes`))[0].n, "2");

    // ---- import a link ----
    const pie = await call("POST", "/recipes/import", { url: `${base}/pie` });
    assert.equal(pie.status, 201, JSON.stringify(pie.body));
    assert.equal(pie.body.created, true);
    const p = pie.body.recipe;
    assert.equal(p.title, "Chicken & leek pie");
    assert.equal(p.url, "https://www.bbcgoodfood.com/recipes/chicken-leek-pie", "kept by its canonical address");
    assert.equal(p.parse, "json-ld");
    assert.equal(p.servings, 6);
    assert.ok(p.saved_id);
    const pageReads = hits.filter((h) => h === "/pie").length;
    assert.equal(pageReads, 1, "the page is fetched once, by Saved, and parsed from that");
    // The same recipe again, by another address for it: the one already kept, without a fetch.
    const dup = await call("POST", "/recipes/import", { url: `${base}/pie?utm_source=whatsapp` });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.recipe.id, p.id);
    const byCanonical = await call("POST", "/recipes/import", { url: "https://www.bbcgoodfood.com/recipes/chicken-leek-pie/" });
    assert.equal(byCanonical.body.recipe.id, p.id);
    assert.equal(byCanonical.body.created, false);

    // Sealed at rest: title, address, body, tags; the blind index stands in for the address.
    const [raw] = await qRaw<{ title: string; url: string; body: string; tags: string[]; url_bidx: string; total_minutes: number }>(`SELECT title, url, body, tags, url_bidx, total_minutes FROM recipes WHERE id = $1`, [p.id]);
    for (const v of [raw.title, raw.url, raw.body, ...raw.tags]) assert.match(v, /^enc:v1:/);
    assert.ok(raw.url_bidx && !raw.url_bidx.includes("bbcgoodfood"));
    assert.equal(raw.total_minutes, 180);

    // A page with no recipe data: kept in Saved, and Try harder offered.
    const plain = await call("POST", "/recipes/import", { url: `${base}/plain` });
    assert.equal(plain.status, 422, JSON.stringify(plain.body));
    assert.deepEqual([plain.body.code, plain.body.harder], ["no_recipe", true]);
    assert.ok(plain.body.saved_id);
    let modelText = "";
    importDeps.model = async (text, pageUrl) => {
      modelText = text;
      return { title: "Granny's soup", url: pageUrl, photo: null, by: null, description: null, servings: 4, yield_text: null, prep_minutes: null, cook_minutes: null, total_minutes: 35, ingredients: ["2 leeks", "25g butter", "1 potato", "1 litre stock"].map(parseIngredient), steps: [{ text: "Soften the leeks in the butter.", section: null }], tags: ["soup"] };
    };
    const harder = await call("POST", "/recipes/import", { url: `${base}/plain`, harder: true });
    assert.equal(harder.status, 201, JSON.stringify(harder.body));
    assert.equal(harder.body.recipe.parse, "model");
    assert.match(modelText, /Soften two leeks/, "the model got the page's readable text");
    assert.equal(harder.body.recipe.saved_id, plain.body.saved_id, "the same Saved item, now filed");

    // A share (Saved's capture route, as the Share sheet sends it) lands in Recipes.
    const shared = await api(new Request("https://athena.test/api/saved", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: JSON.stringify({ url: `${base}/cookies`, source: "share-target" }) }), {} as never);
    const sharedBody = (await shared.json()) as any;
    assert.equal(sharedBody.item.filed.action, "recipe", JSON.stringify(sharedBody));
    const cookiesId = sharedBody.item.filed.href.split("/").pop();
    const cookies = (await call("GET", `/recipes/${cookiesId}`)).body.recipe;
    assert.equal(cookies.title, "BA’s Best Chocolate Chip Cookies");
    // Microdata page too.
    const banana = await call("POST", "/recipes/import", { url: `${base}/banana` });
    assert.equal(banana.body.recipe.parse, "microdata");

    // ---- edit, cook, search ----
    const tz = "Europe/London";
    const today = zonedToday(new Date(), tz);
    const cooked = await call("POST", `/recipes/${jb.id}/cooked`, { on: addDays(today, -2) });
    assert.deepEqual(cooked.body.recipe.cooked, [{ on: addDays(today, -2) }]);
    const soupId = harder.body.recipe.id;
    const edited = await call("PATCH", `/recipes/${soupId}`, { total_minutes: 25, tags: ["soup", "quick"], ingredients: ["3 leeks, sliced", "25g butter", "1 large potato", "1 litre chicken stock", "salt and pepper"], notes: "Blend half." });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.recipe.notes, "Blend half.");
    assert.equal(edited.body.recipe.ingredients[0].quantity, 3);
    const leeks = await call("GET", "/recipes?q=leek");
    assert.deepEqual(leeks.body.recipes.map((r: { title: string }) => r.title).sort(), ["Chicken & leek pie", "Granny's soup"]);
    const quick = await call("GET", "/recipes?time=quick");
    assert.deepEqual(quick.body.recipes.map((r: { title: string }) => r.title), ["Granny's soup"]);
    assert.ok((await call("GET", "/recipes")).body.tags.includes("soup"));

    // ---- Ask: "what can I make with chicken and leeks?" on both back ends ----
    const cites: string[] = [];
    const answer = JSON.parse(await findRecipesJson({ ingredients: ["chicken", "leeks"] }, (id) => (cites.push(id), `recipe:${id}`)));
    assert.equal(answer[0].title, "Chicken & leek pie");
    assert.deepEqual([answer[0].has, answer[0].lacks], [["chicken", "leeks"], []]);
    const soup = answer.find((a: { title: string }) => a.title === "Granny's soup");
    assert.deepEqual([soup.has, soup.lacks], [["leeks"], ["chicken"]], "chicken stock isn't chicken");
    assert.equal(cites[0], p.id);
    const viaAssistant = JSON.parse((await runAssistantTool("find_recipes", { ingredients: ["leeks"], max_minutes: 30 })).result);
    assert.deepEqual(viaAssistant.map((a: { title: string }) => a.title), ["Granny's soup"]);

    // ---- the week plan, around the calendar ----
    const monday = mondayOf(addDays(today, 7));
    const cal = await createConnector({ name: "Google Calendar", provider: "google-calendar", account_label: "", url: "https://calendar.test", auth_type: "oauth", secrets: {} });
    await setConnectorStatus(cal.id, "connected");
    const evening = (day: string, hhmm: string, mins: number, summary: string) => ({ start: new Date(`${day}T${hhmm}:00Z`).toISOString(), end: new Date(Date.parse(`${day}T${hhmm}:00Z`) + mins * 60_000).toISOString(), summary });
    const calendar = { events: async () => [evening(addDays(monday, 1), "19:00", 120, "Book club"), evening(addDays(monday, 3), "18:00", 90, "Five-a-side")] };
    const plan = await getWeekPlan(monday, { calendar });
    assert.equal(plan.days.length, 7);
    assert.ok(plan.days.every((d) => d.suggested));
    assert.equal(plan.days[1].evening.kind, "late");
    assert.match(plan.days[1].reason, /^Quick: Book club at 1[89]:00$/);
    const minutesOf = async (id: string | null) => (id ? ((await call("GET", `/recipes/${id}`)).body.recipe.total_minutes as number | null) : null);
    assert.ok(((await minutesOf(plan.days[1].recipe_id)) ?? 999) <= 30, "a quick one on the late evening");
    const chosen = plan.days.map((d) => d.recipe_id).filter(Boolean);
    assert.equal(new Set(chosen).size, chosen.length, "nothing twice");
    // The chasseur, cooked two days ago, isn't planned before it's a week old.
    const jbDay = plan.days.find((d) => d.recipe_id === jb.id)?.date;
    assert.ok(!jbDay || jbDay > addDays(today, 5), `chasseur planned on ${jbDay}`);
    assert.deepEqual(await getWeekPlan(monday, { calendar }).then((x) => x.days.map((d) => d.recipe_id)), plan.days.map((d) => d.recipe_id), "deterministic");

    // Keep it, then swap two days (what dragging sends), and read it back through the route.
    const kept = await call("PUT", "/recipes/plan", { week: monday, days: plan.days.map((d) => ({ date: d.date, recipe_id: d.recipe_id })) });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.ok(kept.body.days.every((d: { suggested: boolean }) => !d.suggested));
    const [a, b] = [kept.body.days[4], kept.body.days[5]];
    await call("PUT", "/recipes/plan", { week: monday, days: [{ date: a.date, recipe_id: b.recipe_id }, { date: b.date, recipe_id: a.recipe_id, servings: 8 }] });
    const swapped = await call("GET", `/recipes/plan?week=${monday}`);
    assert.deepEqual([swapped.body.days[4].recipe_id, swapped.body.days[5].recipe_id, swapped.body.days[5].servings], [b.recipe_id, a.recipe_id, 8]);
    assert.equal((await call("PUT", "/recipes/plan", { week: monday, days: [{ date: "2001-01-01", recipe_id: null }] })).status, 400);

    // ---- the grocery list ----
    await call("PUT", "/recipes/prefs", { pantry: ["salt", "black pepper", "olive oil", "vegetable oil", "water", "bay leaves"] });
    const week = await call("POST", "/recipes/grocery/add", { week: monday });
    assert.equal(week.status, 200, JSON.stringify(week.body));
    assert.ok(week.body.added > 5);
    assert.ok(week.body.pantry.includes("salt"));
    const items = week.body.items as Array<{ id: string; item: string; quantity: number | null; unit: string | null; aisle: string; recipes: Array<{ id: string; title: string }>; ticked: boolean }>;
    assert.ok(!items.some((i) => /^(salt|bay leaves|olive oil)$/i.test(i.item)), "pantry staples are left off");
    const planned = new Set(swapped.body.days.map((d: { recipe_id: string | null }) => d.recipe_id).filter(Boolean));
    if (planned.has(p.id) && planned.has(soupId)) {
      const leekLine = items.find((i) => /^leeks?$/i.test(i.item))!;
      assert.equal(leekLine.recipes.length, 2, "leeks for the pie and the soup on one line");
    }
    assert.ok(items.every((i) => i.aisle), "every line has an aisle");
    // The pie on its own, for 12: merged into the open lines, not a second copy.
    const before = items.length;
    const more = await call("POST", "/recipes/grocery/add", { recipe_ids: [p.id], servings: { [p.id]: 12 } });
    assert.ok(more.body.items.length <= before + 18);
    const eggs = more.body.items.filter((i: { item: string }) => /eggs/.test(i.item));
    assert.equal(eggs.length, 1);
    // My own line, a tick, clearing ticked ones.
    const own = await call("POST", "/recipes/grocery/items", { item: "2 lemons" });
    const lemons = own.body.items.find((i: { item: string }) => i.item === "lemons");
    assert.deepEqual([lemons.quantity, lemons.own, lemons.aisle], [2, true, "produce"]);
    const ticked = await call("PATCH", `/recipes/grocery/items/${lemons.id}`, { ticked: true });
    assert.equal(ticked.body.items.find((i: { id: string }) => i.id === lemons.id).ticked, true);
    const [sealedLine] = await qRaw<{ item: string }>(`SELECT item FROM grocery_items WHERE id = $1`, [lemons.id]);
    assert.match(sealedLine.item, /^enc:v1:/);
    const cleared = await call("POST", "/recipes/grocery/clear");
    assert.ok(!cleared.body.items.some((i: { id: string }) => i.id === lemons.id));
    assert.equal(cleared.body.items.length, more.body.items.length);

    // ---- Ask imports a recipe from a link, and Undo archives it ----
    pages["/again"] = "bbc-good-food";
    await call("DELETE", `/recipes/${p.id}`);
    const recorded = (await runAssistantTool("import_recipe", { url: `${base}/again` })).changes;
    assert.equal(recorded[0].kind, "recipe");
    const madeId = (recorded[0].open as { id: string }).id;
    assert.equal((await call("GET", `/recipes/${madeId}`)).body.recipe.title, "Chicken & leek pie");
    await applyUndo(recorded[0].undo!);
    assert.equal((await call("GET", `/recipes/${madeId}`)).body.recipe.archived, true);

    // 400s and 404s change nothing.
    assert.equal((await call("POST", "/recipes/import", { url: "not a link" })).status, 400);
    assert.equal((await call("GET", "/recipes/00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await call("PUT", "/recipes/prefs", { system: "furlongs" })).status, 400);
  } finally {
    server.close();
  }
});
