// Real path for @ mentions: GET /api/mentions through the real /api function on Postgres (every migration
// through 0038), across every kind, with a sealed saved item; resolving a message's mentions into the
// context block; the assistant filing exactly the mentioned saved item (not its lookalike) as a gift idea
// for the mentioned person, with the model mocked; and the answer path citing a mentioned person.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/mentions.db.test.ts
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

type Row = { kind: string; id: string; title: string; subtitle: string; updated_at: string; thumb?: string | null };
const base = { type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };

test("@ mentions: /api/mentions across kinds, a sealed saved item, the context block, the assistant and the answer path", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw } = await import("./db");
  const { saveItem } = await import("./saved");
  const { resolveMentions } = await import("./mentions-db");
  const { mentionLink } = await import("./mentions");
  const { answerQuestion } = await import("./answer");
  const { answerSourcesWith } = await import("../netlify/lib/connectors/answer-sources");

  for (const t of ["saved_items", "commitments", "reading_items", "edges", "notes", "events", "people", "places", "organisations", "projects"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const call = async (method: string, path: string, body?: unknown, token: string | null = "master-token-for-tests") => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json()) as any };
  };
  const make = async (path: string, body: unknown) => {
    const r = await call("POST", path, body);
    assert.ok(r.status === 200 || r.status === 201, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  };

  // ---- one of each kind ----
  const rowan = await make("/people", { name: "Rowan Hart", relationship: "niece" });
  const priya = await make("/people", { name: "Priya Shah", relationship: "colleague" });
  const place = await make("/places", { name: "Dishoom King's Cross", address: "Granary Square" });
  const org = await make("/organisations", { name: "Netlify", website: "https://netlify.com" });
  const event = await make("/events", { title: "Rowan's birthday party", date: "2026-12-05" });
  const project = await make("/projects", { name: "Kitchen repaint" });
  const note = await make("/notes", { title: "Pricing call with Priya", body: "Priya thinks £12 a month is right." });
  const todo = await make("/commitments", { title: "Book the dentist", due_on: "2026-11-12" });
  const film = await make("/reading", { title: "Perfect Days", kind: "film", author: "Wim Wenders" });
  // Two saved items with the same title: the owner mentions the second one.
  const notRead = async () => ({ status: "failed" as const });
  const lookalike = (await saveItem({ url: "https://shop.example/green-dress-old", title: "Beautiful green dress", source: "app" }, { read: notRead })).item;
  const dress = (await saveItem({ url: "https://shop.example/green-dress", title: "Beautiful green dress", note: "Size 8, for Rowan?", source: "app" }, { read: notRead })).item;

  // ---- sealed at rest, opened only in the Function ----
  const [raw] = await qRaw<{ title: string; url: string }>(`SELECT title, url FROM saved_items WHERE id = $1`, [dress.id]);
  assert.ok(!raw.title.includes("green") && !raw.url.includes("shop.example"), "the saved item's title and link are sealed");

  // ---- the suggest API ----
  assert.equal((await call("GET", "/mentions?q=green", undefined, null)).status, 401, "needs the app's token");
  const find = async (q: string, extra = "") => {
    const r = await call("GET", `/mentions?q=${encodeURIComponent(q)}${extra}`);
    assert.equal(r.status, 200);
    return r.body.results as Row[];
  };
  const green = await find("green");
  assert.deepEqual(green.map((r) => [r.kind, r.title]), [["saved", "Beautiful green dress"], ["saved", "Beautiful green dress"]]);
  assert.equal(green[0].id, dress.id, "the newer one first");
  assert.equal(green[0].subtitle, "shop.example");
  for (const [q, kind, id] of [
    ["rowan h", "person", rowan.id],
    ["dishoom", "place", place.id],
    ["netlify", "organisation", org.id],
    ["birthday party", "event", event.id],
    ["kitchen", "project", project.id],
    ["pricing call", "note", note.id],
    ["dentist", "todo", todo.id],
    ["perfect", "watch", film.id],
    ["gre dre", "saved", dress.id],
  ] as const) {
    const rows = await find(q);
    assert.deepEqual([rows[0]?.kind, rows[0]?.id], [kind, id], `“${q}” → ${kind}`);
  }
  const dentist = (await find("dentist"))[0];
  assert.equal(dentist.subtitle, "Due Thu 12 Nov");
  assert.equal((await find("perfect"))[0].subtitle, "Film · Wim Wenders");
  // "ro": Rowan the person comes before her birthday party.
  assert.deepEqual((await find("ro")).slice(0, 2).map((r) => r.id), [rowan.id, event.id]);
  // Nothing typed: the recent things, capped; a recent pick comes first.
  const recent = await find("");
  assert.ok(recent.length > 0 && recent.length <= 12);
  assert.equal((await find("", `&recent=watch:${film.id}`))[0].id, film.id);
  assert.ok((await find("x", "&limit=500")).length <= 20, "capped");

  // ---- one thing by its link (a pasted bare athena:// link) ----
  const one = await call("GET", `/mentions/saved/${dress.id.toUpperCase()}`);
  assert.equal(one.status, 200);
  assert.deepEqual([one.body.kind, one.body.id, one.body.title, one.body.subtitle], ["saved", dress.id, "Beautiful green dress", "shop.example"]);
  assert.equal((await call("GET", `/mentions/todo/${todo.id}`)).body.title, "Book the dentist");
  assert.equal((await call("GET", `/mentions/watch/${film.id}`)).body.title, "Perfect Days");
  assert.equal((await call("GET", `/mentions/person/00000000-0000-4000-8000-000000000000`)).status, 404, "gone");
  assert.equal((await call("GET", `/mentions/wardrobe/${dress.id}`)).status, 404, "not a kind");
  assert.equal((await call("GET", `/mentions/saved/${dress.id}`, undefined, null)).status, 401);

  // ---- resolving a message into the context block ----
  const msg = `move ${mentionLink({ kind: "saved", id: dress.id, title: "beautiful green dress" })} as a gift idea for ${mentionLink({ kind: "person", id: rowan.id, title: "Rowan Hart" })}`;
  const resolved = await resolveMentions(`${msg} and ${mentionLink({ kind: "todo", id: "00000000-0000-4000-8000-000000000000", title: "gone" })}`);
  assert.deepEqual(resolved.found.map((m) => [m.kind, m.id, m.title]), [["saved", dress.id, "Beautiful green dress"], ["person", rowan.id, "Rowan Hart"]]);
  assert.deepEqual(Object.fromEntries(resolved.found[0].fields), { "saved kind": "link", url: "https://shop.example/green-dress", site: "shop.example", note: "Size 8, for Rowan?", tags: "", image: "", saved: dress.saved_on });
  assert.equal(resolved.missing.length, 1);
  const todoCtx = (await resolveMentions(mentionLink({ kind: "todo", id: todo.id, title: "dentist" }))).found[0];
  assert.deepEqual([todoCtx.kind, todoCtx.title, Object.fromEntries(todoCtx.fields).due], ["todo", "Book the dentist", "2026-11-12"]);

  // ---- a change: the mentioned ids reach the tool call unchanged ----
  const toolInputs: Array<Record<string, unknown>> = [];
  let round = 0;
  const assistantClient = {
    messages: {
      async create(params: { messages: Array<{ role: string; content: unknown }> }) {
        if (round++ > 0) return { ...base, id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: `Added ${mentionLink({ kind: "saved", id: dress.id, title: "beautiful green dress" })} to Rowan's gift ideas.` }] };
        // The "model" reads the block: the person's id and the saved item's link, nothing looked up again.
        const said = JSON.stringify(params.messages[params.messages.length - 1].content);
        const person = /- person ([0-9a-f-]{36})/.exec(said)![1];
        const link = /- saved [0-9a-f-]{36} [^·]*· saved kind: link; url: (https:[^;]+);/.exec(said)![1];
        const input = { person_id: person, list_title: "Gift ideas", item: `[Beautiful green dress](${link})`, tags: ["gift ideas"] };
        toolInputs.push(input);
        return { ...base, id: "m0", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t0", name: "add_to_list", input }] };
      },
    },
  };
  const reply = await answerQuestion(msg, { sources: answerSourcesWith({ list: async () => [], open: async () => null as never }), client: assistantClient as never, web: async () => false }, { tz: "Europe/London", now: new Date("2026-11-08T09:00:00Z") });
  assert.equal(toolInputs[0].person_id, rowan.id, "the mentioned person's id, unchanged");
  assert.equal(reply.changes?.length, 1);
  const list = (await call("GET", `/notes/${reply.changes![0].id}`)).body;
  assert.match(list.body, /\[Beautiful green dress\]\(https:\/\/shop\.example\/green-dress\)/);
  assert.ok(!list.body.includes("green-dress-old"), `not the lookalike (${lookalike.id})`);
  const links = await qRaw<{ target_id: string }>(`SELECT target_id FROM edges WHERE source_type = 'note' AND source_id = $1 AND target_type = 'person'`, [list.id]);
  assert.deepEqual(links.map((l) => l.target_id), [rowan.id], "the list is Rowan's");
  assert.ok(reply.text.includes(`athena://saved/${dress.id}`), "the reply links back to the item it used");

  // ---- the answer path: "what did @Priya say about pricing?" ----
  let firstAsk = "";
  let asks = 0;
  const answerClient = {
    messages: {
      async create(params: { system: string; messages: Array<{ role: string; content: unknown }> }) {
        if (asks++ === 0) firstAsk = `${params.system}\n${JSON.stringify(params.messages)}`;
        return {
          ...base,
          id: `a${asks}`,
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "done", name: "answer", input: { found: true, text: "She thinks £12 a month is right [1].", sources: [{ ref: `person:${priya.id}`, title: "Priya Shah", date: "" }] } }],
        };
      },
    },
  };
  const question = `what did ${mentionLink({ kind: "person", id: priya.id, title: "Priya Shah" })} say about pricing?`;
  const answer = await answerQuestion(question, { sources: answerSourcesWith({ list: async () => [], open: async () => null as never }), client: answerClient as never }, { tz: "Europe/London", now: new Date("2026-11-08T09:00:00Z") });
  assert.ok(firstAsk.includes(`(cite as person:${priya.id})`), "the answer path gets the block");
  assert.ok(firstAsk.includes("Pricing call with Priya"), "and the first search used the words, not the link");
  assert.equal(answer.sources?.[0]?.kind, "person");
  assert.equal(answer.sources?.[0]?.id, priya.id, "a mentioned person can be cited");
});
