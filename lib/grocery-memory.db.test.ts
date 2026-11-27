// Real path: what the grocery list remembers, through the real /api function on Postgres with every
// migration. Shops filed by Done shopping are sealed and learned from: usuals come due, a skip puts one
// off, the walk round the shop reorders the aisles, Undo puts a shop's lines back, and Settings can
// forget every shop. Ask's add_to_grocery_list skips what's already there and undoes, and the MCP
// tools read and add.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/grocery-memory.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("grocery memory: shops are filed and sealed, usuals come due, the walk is learned, Undo and Forget work", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw, getOwnerTimeZone } = await import("./db");
  const { zonedToday, addDays } = await import("./dates");
  const { runAssistantTool, applyUndo } = await import("./assistant");

  for (const t of ["grocery_bought", "grocery_trips", "grocery_skips", "grocery_items"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key = 'recipes'`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(
      new Request(`https://athena.test/api${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {} as never,
    );
    return { status: res.status, body: await res.json() };
  };

  // Nothing remembered yet: no usuals, the usual aisle order.
  const empty = await call("GET", "/recipes/grocery");
  assert.deepEqual([empty.body.usuals, empty.body.order], [[], null]);
  assert.deepEqual((await call("GET", "/recipes/grocery/history")).body, { shops: 0, since: null });

  // Three past shops of milk, four days apart, each a walk: bread, then veg, then dairy.
  const today = zonedToday(new Date(), await getOwnerTimeZone());
  const { sealer } = await import("./db");
  const s = await sealer();
  for (const ago of [12, 8, 4]) {
    const at = new Date(`${addDays(today, -ago)}T10:00:00Z`);
    const [trip] = await qRaw<{ id: string }>(`INSERT INTO grocery_trips (done_at, item_count, aisle_order) VALUES ($1, 3, ARRAY['bakery','produce','dairy-eggs']) RETURNING id`, [at]);
    for (const [item, aisle] of [["milk", "dairy-eggs"], ["bread", "bakery"], ["lemons", "produce"]]) {
      await qRaw(`INSERT INTO grocery_bought (trip_id, item, aisle, quantity, unit, bought_at) VALUES ($1, $2, $3, $4, $5, $6)`, [trip.id, s.text(item), aisle, item === "milk" ? 2 : null, item === "milk" ? "pint" : null, at]);
    }
  }
  const learned = await call("GET", "/recipes/grocery");
  assert.deepEqual(learned.body.usuals.map((u: { item: string }) => u.item).sort(), ["bread", "lemons", "milk"]);
  const milk = learned.body.usuals.find((u: { item: string }) => u.item === "milk");
  assert.deepEqual([milk.every, milk.since, milk.quantity, milk.unit], [4, 4, 2, "pint"]);
  assert.deepEqual(learned.body.order.slice(0, 3), ["bakery", "produce", "dairy-eggs"]);

  // A usual on the list isn't offered; a skipped one isn't either, until it's due again.
  await call("POST", "/recipes/grocery/items", { item: "2 pints milk" });
  const skipped = await call("POST", "/recipes/grocery/skip", { item: "bread" });
  assert.deepEqual(skipped.body.usuals.map((u: { item: string }) => u.item), ["lemons"]);
  const [skip] = await qRaw<{ item: string; until: string }>(`SELECT item, to_char(until, 'YYYY-MM-DD') AS until FROM grocery_skips`);
  assert.match(skip.item, /^enc:v1:/);
  assert.equal(skip.until, addDays(today, 4));

  // Done shopping files the ticked line, sealed, and takes it off the list.
  const list = (await call("GET", "/recipes/grocery")).body.items;
  await call("PATCH", `/recipes/grocery/items/${list[0].id}`, { ticked: true });
  const done = await call("POST", "/recipes/grocery/done", {});
  assert.equal(done.status, 200);
  assert.equal(done.body.count, 1);
  assert.equal(done.body.items.length, 0);
  const [bought] = await qRaw<{ item: string; quantity: string; own: boolean }>(`SELECT item, quantity, own FROM grocery_bought WHERE trip_id = $1`, [done.body.trip_id]);
  assert.match(bought.item, /^enc:v1:/);
  assert.deepEqual([Number(bought.quantity), bought.own], [2, true]);
  const [trip] = await qRaw<{ aisle_order: string[] }>(`SELECT aisle_order FROM grocery_trips WHERE id = $1`, [done.body.trip_id]);
  assert.deepEqual(trip.aisle_order, [], "one tick isn't a walk");
  assert.equal((await call("POST", "/recipes/grocery/done", {})).body.count, 0, "nothing ticked, nothing filed");

  // Undo: the line is back, ticked, and the shop is gone.
  const undone = await call("DELETE", `/recipes/grocery/shops/${done.body.trip_id}`);
  assert.equal(undone.status, 200);
  assert.deepEqual(undone.body.items.map((i: { item: string; ticked: boolean }) => [i.item, i.ticked]), [["milk", true]]);
  assert.equal((await call("DELETE", `/recipes/grocery/shops/${done.body.trip_id}`)).status, 404);

  // A walk round the shop: three aisles ticked over ten minutes. Undo keeps each tick's time, so filing it again still learns the walk.
  await qRaw(`DELETE FROM grocery_items`);
  for (const [i, text] of ["bread", "2 lemons", "milk"].entries()) {
    const added = await call("POST", "/recipes/grocery/items", { item: text });
    const id = added.body.items.find((x: { ticked: boolean }) => !x.ticked).id;
    await qRaw(`UPDATE grocery_items SET ticked_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [id, String(10 - i * 5)]);
  }
  const walked = await call("POST", "/recipes/grocery/done", {});
  const order = async (id: string) => (await qRaw<{ aisle_order: string[] }>(`SELECT aisle_order FROM grocery_trips WHERE id = $1`, [id]))[0].aisle_order;
  assert.deepEqual(await order(walked.body.trip_id), ["bakery", "produce", "dairy-eggs"]);
  await call("DELETE", `/recipes/grocery/shops/${walked.body.trip_id}`);
  const again = await call("POST", "/recipes/grocery/done", {});
  assert.deepEqual(await order(again.body.trip_id), ["bakery", "produce", "dairy-eggs"], "the walk survives Undo");
  await call("DELETE", `/recipes/grocery/shops/${again.body.trip_id}`);
  await qRaw(`DELETE FROM grocery_items`);
  await call("POST", "/recipes/grocery/items", { item: "2 pints milk" });
  const milkLine = (await call("GET", "/recipes/grocery")).body.items[0];
  await call("PATCH", `/recipes/grocery/items/${milkLine.id}`, { ticked: true });

  // Ask adds lines, skipping one already on the list, and Undo takes back only what it added.
  const asked = await runAssistantTool("add_to_grocery_list", { items: ["eggs", "2 lemons", "Eggs"] });
  assert.equal(asked.changes.length, 1);
  assert.match(asked.changes[0].detail, /^Added eggs, 2 lemons · Eggs already on it/);
  const withAsk = (await call("GET", "/recipes/grocery")).body.items.map((i: { item: string }) => i.item).sort();
  assert.deepEqual(withAsk, ["eggs", "lemons", "milk"]);
  await applyUndo(asked.changes[0].undo!);
  assert.deepEqual((await call("GET", "/recipes/grocery")).body.items.map((i: { item: string }) => i.item), ["milk"]);

  // The MCP tools: read the list in the stored-content envelope, add with the same skipping.
  const { registerGroceryTools } = await import("../netlify/lib/mcp/grocery");
  const results = await import("../netlify/lib/mcp/results");
  const tools = new Map<string, (args: never) => Promise<{ content: Array<{ text: string }> }>>();
  registerGroceryTools({ tool: (name: string, _d: string, _s: unknown, fn: never) => tools.set(name, fn) } as never, results);
  const added = JSON.parse((await tools.get("athena_add_to_grocery_list")!({ items: ["bin bags", "milk", "Bin bags"] } as never)).content[0].text);
  assert.deepEqual(added, { added: ["bin bags", "milk"], already_on_the_list: ["Bin bags"] }, "a ticked line is in the basket, so milk goes on again");
  const read = JSON.parse((await tools.get("athena_get_grocery_list")!({} as never)).content[0].text);
  assert.ok(read.content_notice);
  assert.deepEqual(read.data.to_buy.map((l: { line: string }) => l.line), ["bin bags", "milk"]);
  assert.deepEqual(read.data.in_the_basket, ["2 pints milk"]);
  await qRaw(`DELETE FROM grocery_items WHERE ticked_at IS NULL`);

  // Turning usuals off hides them; the aisle order stays.
  await call("PUT", "/recipes/prefs", { usuals: false });
  const off = await call("GET", "/recipes/grocery");
  assert.deepEqual(off.body.usuals, []);
  assert.ok(off.body.order);

  // Forget every shop.
  const history = (await call("GET", "/recipes/grocery/history")).body;
  assert.deepEqual(history, { shops: 3, since: addDays(today, -12) });
  assert.deepEqual((await call("DELETE", "/recipes/grocery/history")).body, { shops: 3 });
  const forgot = await call("GET", "/recipes/grocery");
  assert.equal(forgot.body.order, null);
  assert.equal(forgot.body.items.length, 1, "the list itself stays");
  const [{ n }] = await qRaw<{ n: string }>(`SELECT count(*)::text AS n FROM grocery_skips`);
  assert.equal(n, "0");
});
