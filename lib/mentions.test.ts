// @ mentions: the link kinds, parsing and serialising, ranking, the context block, and the assistant's request.
// Run: npx tsx --test lib/mentions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAthenaLink, parseAthenaLinks, parseAthenaUrl, replaceAthenaLinks, contentLinkKeys } from "./links";
import {
  MENTION_LIMIT,
  MENTION_PER_KIND,
  MENTION_RULE,
  matchScore,
  mentionBlock,
  mentionLabel,
  mentionLink,
  mentionsIn,
  mentionsToText,
  rankMentions,
  savedTitle,
  shortDate,
  type MentionResult,
} from "./mentions";
import { runAsk } from "./answer";

const DRESS = "0b9a7c1e-4d2f-4a51-9c3e-7f1d2a6b8e01";
const ROWAN = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const TODO = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const FILM = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";

test("saved, todo and watch round-trip as athena:// links; the old kinds are unchanged", () => {
  for (const kind of ["saved", "todo", "watch", "person", "note", "record"] as const) {
    const md = formatAthenaLink(kind, DRESS, "@Beautiful [green] dress");
    assert.deepEqual(parseAthenaLinks(`x ${md} y`), [{ kind, id: DRESS, label: "@Beautiful [green] dress" }]);
    assert.deepEqual(parseAthenaUrl(`athena://${kind}/${DRESS.toUpperCase()}`), { kind, id: DRESS });
  }
  assert.equal(parseAthenaUrl(`athena://wardrobe/${DRESS}`), null, "an unknown kind isn't a link");
  // Keyword search and plain text see the label; content-link sync sees the target.
  const body = `Gift for ${formatAthenaLink("person", ROWAN, "@Rowan")}: ${formatAthenaLink("saved", DRESS, "@Green dress")}`;
  assert.equal(replaceAthenaLinks(body, (l) => l.label), "Gift for @Rowan: @Green dress");
  assert.deepEqual(contentLinkKeys(body), [`person:${ROWAN}`, `saved:${DRESS}`]);
});

test("a message's mentions: parsed once each, in order, and read as their labels", () => {
  const msg = `move ${mentionLink({ kind: "saved", id: DRESS, title: "beautiful green dress" })} as a gift idea for ${mentionLink({ kind: "person", id: ROWAN, title: "Rowan" })}, like ${formatAthenaLink("saved", DRESS, "@it")}`;
  assert.deepEqual(
    mentionsIn(msg).map((l) => [l.kind, l.id, l.label]),
    [
      ["saved", DRESS, "@beautiful green dress"],
      ["person", ROWAN, "@Rowan"],
    ],
  );
  assert.equal(mentionsToText(msg), "move @beautiful green dress as a gift idea for @Rowan, like @it");
  assert.equal(mentionsToText("no mentions here [x](https://a.example)"), "no mentions here [x](https://a.example)");
});

test("labels are one short line; saved items are named whatever their kind", () => {
  assert.equal(mentionLabel("  Lego \n Ferrari "), "@Lego Ferrari");
  assert.equal(mentionLabel("x".repeat(120)).length, 81);
  assert.equal(savedTitle({ kind: "quote", quote: " Make it work. ", title: "c2" }), "Make it work.");
  assert.equal(savedTitle({ kind: "image", title: null, note: "Print for the spare room?" }), "Print for the spare room?");
  assert.equal(savedTitle({ kind: "image", site: "etsy.com" }), "Image from etsy.com");
  assert.equal(savedTitle({ kind: "link", title: null, url: "https://a.example/x" }), "https://a.example/x");
  assert.equal(shortDate("2026-11-09"), "Mon 9 Nov");
});

test("match quality: exact, then prefix, then each word starting a word, then anywhere", () => {
  assert.equal(matchScore("Mum", "mum"), 4);
  assert.equal(matchScore("Mum's birthday", "mum"), 3);
  assert.equal(matchScore("Beautiful green dress", "gre dre"), 2);
  assert.equal(matchScore("Evergreen", "green"), 1);
  assert.equal(matchScore("Priya", "dress"), 0);
  assert.equal(matchScore("Anything", ""), 1);
});

test("ranking: closer matches first, then recent; recent picks lifted; per-kind and total caps", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const row = (kind: MentionResult["kind"], id: string, title: string, daysAgo: number): MentionResult => ({
    kind,
    id,
    title,
    subtitle: "",
    updated_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
  });
  const rows = [
    row("todo", "t1", "Mum's photos from the weekend", 0),
    row("person", "p1", "Mum", 40),
    row("event", "e1", "Mum's birthday", 3),
    row("record", "r1", "Château Musar", 1),
    row("note", "n1", "Notes on Tom", 0),
  ];
  const mu = rankMentions(rows, "mu", { now }).map((r) => r.id);
  assert.equal(mu[0], "p1", "Mum herself, though the to-do is newer");
  assert.deepEqual([...mu].sort(), ["e1", "p1", "r1", "t1"], "Tom's note doesn't match");
  assert.equal(mu[3], "r1", "a match inside a word comes last");
  // Among equals, the more recent one leads.
  const same = [row("saved", "old", "Green dress", 30), row("saved", "new", "Green dress", 1)];
  assert.deepEqual(rankMentions(same, "green", { now }).map((r) => r.id), ["new", "old"]);
  // What you picked lately comes first, newest pick first.
  assert.deepEqual(rankMentions(same, "green", { now, picked: ["saved:old"] }).map((r) => r.id), ["old", "new"]);
  // Duplicates and blank titles go; nothing that doesn't match stays.
  assert.equal(rankMentions([...rows, rows[1], row("note", "blank", "  ", 0)], "zzz", { now }).length, 0);
  const many = Array.from({ length: 30 }, (_, i) => row(i % 2 ? "note" : "saved", `x${i}`, `Thing ${i}`, i));
  const ranked = rankMentions(many, "", { now });
  assert.equal(ranked.length, MENTION_PER_KIND * 2);
  assert.ok(ranked.length <= MENTION_LIMIT);
  assert.equal(ranked.filter((r) => r.kind === "saved").length, MENTION_PER_KIND);
});

test("the context block: kind, id, title and key fields for each mention, and what's missing", () => {
  const block = mentionBlock(
    [
      { kind: "saved", id: DRESS, title: "Beautiful green dress", ref: `saved:${DRESS}`, fields: [["url", "https://shop.example/dress"], ["note", ""], ["site", "shop.example"]] },
      { kind: "person", id: ROWAN, title: "Rowan", ref: `person:${ROWAN}`, fields: [["relationship", "niece"]] },
    ],
    [{ kind: "todo", id: TODO, label: "@Book the dentist" }],
  );
  assert.equal(
    block,
    [
      "<mentioned>",
      `- saved ${DRESS} "Beautiful green dress" · url: https://shop.example/dress; site: shop.example`,
      `- person ${ROWAN} "Rowan" · relationship: niece`,
      `- todo ${TODO} "Book the dentist" · not found (archived or deleted)`,
      "</mentioned>",
    ].join("\n"),
  );
  // The answer path cites them by ref.
  assert.match(mentionBlock([{ kind: "person", id: ROWAN, title: "Rowan", ref: `person:${ROWAN}`, fields: [] }], [], { cite: true }), /\(cite as person:/);
  assert.equal(mentionBlock([], []), "");
  // Long fields are cut, never the id.
  assert.ok(mentionBlock([{ kind: "watch", id: FILM, title: "Dune", fields: [["notes", "y".repeat(1000)]] }]).length < 500);
});

test("the assistant gets the block and the rule with the owner's message, and the model's id reaches the tool unchanged", async () => {
  const text = `move ${mentionLink({ kind: "saved", id: DRESS, title: "beautiful green dress" })} as a gift idea for ${mentionLink({ kind: "person", id: ROWAN, title: "Rowan" })}`;
  const seen: Array<{ system: string; last: string }> = [];
  let fromBlock: string[] = [];
  let round = 0;
  const client = {
    messages: {
      async create(params: { system: string; messages: Array<{ role: string; content: unknown }> }) {
        const last = params.messages.filter((m) => m.role === "user").pop()!;
        seen.push({ system: params.system, last: JSON.stringify(last.content) });
        const base = { id: `m${round}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (round++ === 0) {
          // The "model" takes the ids from the block, as the rule tells it to.
          fromBlock = [...String(seen[0].last).matchAll(/- (saved|person) ([0-9a-f-]{36})/g)].map((m) => m[2]);
          return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "t0", name: "find_notes", input: { person_id: fromBlock[1], query: "gift" } }] };
        }
        return { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
      },
    },
  };
  const reply = await runAsk(text, {
    client: client as never,
    sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) },
    web: async () => false,
    mentions: async () => ({
      found: [
        { kind: "saved", id: DRESS, title: "Beautiful green dress", fields: [["url", "https://shop.example/dress"]] },
        { kind: "person", id: ROWAN, title: "Rowan", fields: [["relationship", "niece"]] },
      ],
      missing: [],
    }),
  }, { tz: "Europe/London", now: new Date("2026-11-08T09:00:00Z") });
  assert.ok(seen[0].system.includes(MENTION_RULE), "the rule is in the system prompt");
  assert.match(seen[0].last, new RegExp(`<mentioned>.*saved ${DRESS}.*https://shop.example/dress.*person ${ROWAN}`));
  assert.ok(seen[0].last.includes(`athena://saved/${DRESS}`), "the message keeps its links");
  // The ids the model reads are the mentioned ones, character for character (the db test runs the tools for real).
  assert.deepEqual(fromBlock, [DRESS, ROWAN]);
  assert.ok(seen[1].last.includes("t0"), "the tool's result went back to the model");
  assert.equal(reply.text, "Done.");
});

test("no mentions: no block and no rule", async () => {
  let system = "";
  const client = {
    messages: {
      async create(params: { system: string }) {
        system = params.system;
        return { id: "m", type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [{ type: "text", text: "Hi." }] };
      },
    },
  };
  await runAsk("hello", { client: client as never, sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, web: async () => false, mentions: async () => ({ found: [], missing: [] }) }, { tz: "Europe/London" });
  assert.ok(!system.includes(MENTION_RULE));
});

test("a field that isn't text (a date from the database, null, a number) doesn't stop the block", () => {
  const fields = [["kind", "meeting"], ["date", new Date("2026-11-12T12:00:00Z")], ["person_id", null], ["count", 3]] as unknown as Array<[string, string]>;
  const block = mentionBlock([{ kind: "event", id: ROWAN, title: "Sam :: Jordan", fields }]);
  assert.match(block, /"Sam :: Jordan" · kind: meeting; date: 2026-11-12T12:00:00.000Z; count: 3\n/);
});
