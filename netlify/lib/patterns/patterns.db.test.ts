// Real path for patterns: health days sealed through saveHealthDay, moods through patchDay, timed meetings in
// events, then the real /api function's GET /api/patterns and /api/patterns/digest, and Ask's patterns tool through
// answerQuestion with a scripted model. Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/patterns/patterns.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties health, days and events first.
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

const TZ = "Europe/London";

test("Patterns: found from sealed days, served to the owner only, nothing written or logged, and Ask reads them for a sleep question", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { createApiKey } = await import("../../../lib/api-keys");
  const { zonedToday, zonedToInstant, addDays } = await import("../../../lib/dates");
  const { saveHealthDay } = await import("../../../lib/health");
  const { patchDay } = await import("../../../lib/days");
  const { forgetPatternDays } = await import("../../../lib/patterns-data");
  const { answerQuestion } = await import("../../../lib/answer");
  const { answerSourcesWith } = await import("../connectors/answer-sources");

  for (const t of ["day_files", "day_entries", "days", "location_todo", "location_cache", "place_geo"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM notes`);
  await qRaw(`DELETE FROM edges WHERE source_type = 'event'`);
  await qRaw(`DELETE FROM events`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('health', 'location')`);
  await qRaw(`DELETE FROM settings WHERE key = 'health_sources'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  forgetPatternDays();

  // ---- 100 made-up days: yoga every third day and a longer night after it; a meeting after 6pm every fourth day and a lower mood ----
  const today = zonedToday(new Date(), TZ);
  let s = 42;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const noise = (sd: number) => (r() + r() + r() + r() - 2) * sd * 0.866;
  const yoga = new Set<string>();
  const late = new Set<string>();
  for (let i = 100; i >= 1; i--) {
    const date = addDays(today, -i);
    if (i % 3 === 0) yoga.add(date);
    if (i % 4 === 1) late.add(date);
  }
  // Meetings have someone else on them (an edge to a person); a solo appointment doesn't count.
  const [priya] = await qRaw<{ id: string }>(`INSERT INTO people (name) VALUES ('Priya Shah') RETURNING id`);
  const meeting = async (date: string, time: string, title: string) => {
    const [ev] = await qRaw<{ id: string }>(`INSERT INTO events (title, kind, date, starts_at) VALUES ($3, 'other', $1::date, $2::timestamptz) RETURNING id`, [date, zonedToInstant(date, time, TZ).toISOString(), title]);
    await qRaw(`INSERT INTO edges (source_type, source_id, target_type, target_id) VALUES ('event', $1, 'person', $2)`, [ev.id, priya.id]);
  };
  for (let i = 100; i >= 1; i--) {
    const date = addDays(today, -i);
    const sleep = Math.round(425 + noise(20) + (yoga.has(addDays(date, -1)) ? 42 : 0));
    await saveHealthDay(
      {
        date,
        source: "apple_health",
        sleep_minutes: sleep,
        sleep_stages: { deep: Math.round(sleep * 0.18), core: Math.round(sleep * 0.6), rem: sleep - Math.round(sleep * 0.18) - Math.round(sleep * 0.6) },
        steps: Math.round(8200 + noise(1500)),
        resting_hr: Math.round(54 + noise(2)),
        ...(yoga.has(date) ? { workouts: [{ type: "Yoga", minutes: 40, start: "07:00" }] } : {}),
      },
      { tz: TZ },
    );
    await patchDay(date, { mood: Math.max(1, Math.min(5, Math.round(3.6 - (late.has(date) ? 1.4 : 0) + noise(0.45)))) as 1 }, { tz: TZ });
    await meeting(date, "09:30", "Standup");
    if (late.has(date)) await meeting(date, "19:00", "Late call");
    // A solo appointment after 6pm on the other days: if it counted, the late-meeting pattern would vanish.
    else await qRaw(`INSERT INTO events (title, kind, date, starts_at) VALUES ('Gym class', 'appointment', $1::date, $2::timestamptz)`, [date, zonedToInstant(date, "19:30", TZ).toISOString()]);
  }
  forgetPatternDays();

  const call = async (path: string, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { headers: { Authorization: `Bearer ${token}` } }), {} as never);
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const counts = async () =>
    JSON.stringify(
      await qRaw(
        `SELECT (SELECT count(*) FROM sensitive_blobs) AS blobs, (SELECT count(*) FROM days) AS days, (SELECT count(*) FROM day_entries) AS entries,
                (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM settings) AS settings, (SELECT count(*) FROM metrics) AS metrics,
                (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tables`,
      ),
    );
  const { token: capture } = await createApiKey("iPhone", "capture");
  const before = await counts();
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    // ---- GET /api/patterns: the owner's ----
    const res = await call("/patterns?window=90");
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.window, 90);
    assert.equal(res.json.to, today);
    const ids = res.json.patterns.map((p: { id: string }) => p.id);
    const sleep = res.json.patterns.find((p: { id: string }) => p.id === "workout:yoga|sleep|0");
    assert.ok(sleep, ids.join(", "));
    assert.match(sleep.line, /^You sleep (35|40|45|50) min longer on days you do yoga$/);
    assert.match(sleep.evidence, /^Longer than usual on \d+ of \d+ days you do yoga$/);
    assert.ok(sleep.dates.every((d: string) => yoga.has(d)));
    const mood = res.json.patterns.find((p: { id: string }) => p.id === "late_meeting|mood|0");
    assert.ok(mood, ids.join(", "));
    assert.equal(mood.line, "Your mood is lower on days with a meeting after 6pm");
    assert.ok(res.json.patterns.length <= 6);

    // The other windows, one outcome, and plain refusals.
    const month = await call("/patterns?window=30&outcome=sleep,deep");
    assert.equal(month.status, 200, month.text);
    assert.ok(month.json.patterns.every((p: { outcome: string }) => p.outcome === "sleep" || p.outcome === "deep"));
    assert.equal((await call("/patterns?window=365")).status, 200);
    assert.equal((await call("/patterns?window=7")).status, 400);
    assert.equal((await call("/patterns?outcome=weight")).status, 400);

    // ---- the weekly digest ----
    const dg = await call("/patterns/digest");
    assert.equal(dg.status, 200, dg.text);
    assert.match(dg.json.week_of, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(dg.json.items) && dg.json.items.length <= 3 && Array.isArray(dg.json.faded));

    // ---- a capture key reads nothing ----
    assert.equal((await call("/patterns", capture)).status, 401);
    assert.equal((await call("/patterns/digest", capture)).status, 401);

    // ---- Ask: offered for every question (the model picks it), with the evidence; cards only when it was read ----
    const ask = async (question: string, use = true) => {
      const seen: string[] = [];
      const offered: string[][] = [];
      let round = 0;
      const client = {
        messages: {
          async create(params: { messages: unknown; tools?: Array<{ name: string }> }) {
            const base = { id: `m${round}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
            seen.push(JSON.stringify(params.messages));
            offered.push((params.tools ?? []).map((t) => t.name));
            if (round++ === 0 && use && offered[0].includes("patterns")) return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "t0", name: "patterns", input: { outcome: "sleep" } }] };
            const day = [...yoga].sort().at(-1)!;
            return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "done", name: "answer", input: { found: true, text: "You tend to sleep about 40 min longer on days you do yoga [1].", sources: [{ ref: `day:${day}`, title: "Yoga", date: day }] } }] };
          },
        },
      };
      const reply = await answerQuestion(question, { sources: answerSourcesWith({ list: async () => [], open: async () => null as never }), client: client as never }, { tz: TZ });
      return { reply, seen: seen.join("\n"), offered: offered[0] };
    };
    const helps = await ask("What helps me sleep?");
    assert.ok(helps.offered.includes("patterns"), "offered for a sleep question");
    assert.match(helps.seen, /You sleep \d+ min longer on days you do yoga/);
    assert.match(helps.seen, /Longer than usual on \d+ of \d+ days you do yoga/);
    assert.match(helps.seen, /day:\d{4}-\d{2}-\d{2}/, "recent days to cite");
    assert.doesNotMatch(helps.seen, /Your mood is lower/, "sleep only, as asked");
    assert.equal(helps.reply.sources?.[0]?.kind, "day");
    assert.ok(helps.reply.patterns?.length && helps.reply.patterns.length <= 2, "the answer carries its patterns as cards");
    assert.ok(helps.reply.patterns!.every((p) => p.dates.length === 0 && p.outcome.match(/sleep|deep/)), "without their dates");
    // No keyword gate any more: offered for a watching question too, and only read when the model calls it.
    const films = await ask("What films did I watch last week?", false);
    assert.ok(films.offered.includes("patterns"), "offered whatever the question's words");
    assert.doesNotMatch(films.seen, /You sleep \d+ min longer/, "not read unless called");
    assert.equal(films.reply.patterns, undefined);
  } finally {
    Object.assign(console, orig);
  }

  // ---- nothing written, nothing logged ----
  assert.equal(await counts(), before, "reading patterns writes no rows and makes no tables");
  assert.ok(!logged.some((l) => /\d{3}|yoga|sleep|mood/i.test(l)), `logged: ${logged.join(" | ")}`);
  forgetPatternDays();
});
