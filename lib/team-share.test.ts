// Shared assistants (lib/team-share.ts): reading assistant.json as someone else's words, making one from an assistant,
// taking out links into the owner's own Athena, the personal-data check, folders and links, and what an
// import may grant. Every person, place and address here is made up. Nothing needs a database.
// Run: npx tsx --test lib/team-share.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answersSection,
  bundleFromEntries,
  bundleFromText,
  checkFields,
  findPersonal,
  grantedTools,
  linkedHosts,
  needsOf,
  parseShareLink,
  readShared,
  scrubText,
  serialiseShared,
  triggerInputs,
  withAnswers,
  sharedFromAssistant,
  shareSlug,
  ShareFormatError,
  type KnownTerm,
} from "./team-share";
import type { TeamAssistant } from "./team-types";

const AVATAR = { v: 1, seed: "penny", species: "fox", fur: "ginger", accent: "peach", eyes: "round", mouth: "small-smile", outfit: "hoodie", outfitColor: "teal", accessories: ["glasses"] } as const;
const PERSONALITY = { tone: "warm", traits: ["thrifty"], pronoun: "they", greeting: "Hi! I'll keep an eye on prices." } as const;

const PENNY: Pick<TeamAssistant, "name" | "job" | "instructions" | "personality" | "avatar" | "triggers" | "allow" | "web"> = {
  name: "Penny",
  job: "Finds good prices for gift ideas",
  instructions: "Check the shops I trust for each gift idea and tell me when the price drops.",
  personality: { ...PERSONALITY, traits: [...PERSONALITY.traits] },
  avatar: { ...AVATAR, accessories: ["glasses"] },
  triggers: [
    { id: "t1", assistant_id: "a1", kind: "event", days: [], time: null, event: { source: "saved", savedAction: "gift-idea" }, paused: false, last_slot: null, last_fired_at: null, created_at: "2026-11-01T00:00:00Z" },
    { id: "t2", assistant_id: "a1", kind: "schedule", days: [5], time: "17:00", event: null, paused: false, last_slot: "x", last_fired_at: null, created_at: "2026-11-01T00:00:00Z" },
  ],
  allow: ["add_to_list"],
  web: true,
};

const minimal = (over: Record<string, unknown> = {}) => ({ format: 1, job: "Turns Linear issues into to-dos", ...over });

// ---------- reading assistant.json ----------

test("readShared: a minimal shared reads, with safe defaults", () => {
  const w = readShared(minimal());
  assert.equal(w.job, "Turns Linear issues into to-dos");
  assert.equal(w.name, "");
  assert.deepEqual(w.triggers, []);
  assert.deepEqual(w.would_like, []);
  assert.equal(w.web, false);
  assert.equal(w.avatar, null);
  assert.equal(w.personality, null);
});

test("readShared: wrong or newer formats are refused with words for the owner", () => {
  assert.throws(() => readShared(null), ShareFormatError);
  assert.throws(() => readShared({ job: "x" }), /format/);
  assert.throws(() => readShared({ format: 2, job: "x" }), /newer Athena/);
  assert.throws(() => readShared({ format: 1 }), /job: missing/);
  assert.throws(() => readShared(minimal({ job: "x".repeat(200) })), /job: over/);
});

test("readShared: triggers are checked; event connectors become needs", () => {
  const w = readShared(
    minimal({
      triggers: [
        { kind: "schedule", days: [1, 1, 5, 9], time: "08:30" },
        { kind: "event", event: { source: "collected", connector: "Linear", kind: "issue", tag: "#urgent", extra: "dropped" } },
      ],
      needs: ["gmail", "Not a provider!"],
    }),
  );
  assert.deepEqual(w.triggers[0], { kind: "schedule", days: [1, 5], time: "08:30" });
  assert.deepEqual(w.triggers[1], { kind: "event", event: { source: "collected", connector: "linear", kind: "issue", tag: "urgent" } });
  assert.deepEqual(w.needs, ["linear", "gmail"]);
  assert.throws(() => readShared(minimal({ triggers: [{ kind: "schedule", days: [], time: "08:00" }] })), /needs days/);
  assert.throws(() => readShared(minimal({ triggers: [{ kind: "schedule", days: [1], time: "25:00" }] })), /needs a time/);
  assert.throws(() => readShared(minimal({ triggers: [{ kind: "event", event: { source: "inbox" } }] })), /event.source/);
  assert.throws(() => readShared(minimal({ triggers: Array.from({ length: 9 }, () => ({ kind: "schedule", days: [1], time: "08:00" })) })), /8 at most/);
});

test("readShared: looks Athena can't draw are dropped, not refused", () => {
  assert.deepEqual(readShared(minimal({ avatar: AVATAR })).avatar, AVATAR);
  assert.equal(readShared(minimal({ avatar: { ...AVATAR, species: "dragon" } })).avatar, null);
  assert.equal(readShared(minimal({ avatar: { ...AVATAR, accessories: ["beanie", "crown"] } })).avatar, null, "two on the head");
  assert.equal(readShared(minimal({ personality: { tone: "smug", pronoun: "they" } })).personality, null);
});

test("readShared: tool names, author, version and based_on are kept only when well formed", () => {
  const w = readShared(minimal({ would_like: ["add_todo", "DROP TABLE", "add_todo"], author: "@sample-author", version: "1.2.0", based_on: "https://github.com/sample-author/athena-assistants/tree/main/gift-prices/" }));
  assert.deepEqual(w.would_like, ["add_todo"]);
  assert.equal(w.author, "sample-author");
  assert.equal(w.version, "1.2.0");
  assert.equal(w.based_on, "https://github.com/sample-author/athena-assistants/tree/main/gift-prices");
  const odd = readShared(minimal({ author: "not a handle", version: "<b>", based_on: "https://athena.example.com/w/1" }));
  assert.equal(odd.author, undefined);
  assert.equal(odd.version, undefined);
  assert.equal(odd.based_on, undefined, "only GitHub links are kept");
});

test("readShared: asks are tidied; more than four is refused", () => {
  const w = readShared(minimal({ asks: [{ question: "Which shops do you trust?", choices: ["Any", "Ones I've used"] }, "Which shops do you trust?", { question: "Budget?", choices: ["One"] }] }));
  assert.deepEqual(w.asks, [
    { question: "Which shops do you trust?", choices: ["Any", "Ones I've used"] },
    { question: "Budget?", choices: [] },
  ]);
  assert.throws(() => readShared(minimal({ asks: ["a?", "b?", "c?", "d?", "e?"] })), /4 questions/);
});

test("serialiseShared reads back as the same shared assistant", () => {
  const w = sharedFromAssistant(PENNY, { summary: "Checks prices.", answers: [{ question: "Which shops do you trust?", answer: "Shops on Example Street" }] });
  assert.deepEqual(readShared(JSON.parse(serialiseShared(w))), w);
});

// ---------- making one ----------

test("sharedFromAssistant: no ids, slots or answers; allow becomes a request", () => {
  const w = sharedFromAssistant(PENNY, { answers: [{ question: "Which shops do you trust?", answer: "Shops on Example Street" }] });
  const text = serialiseShared(w);
  assert.doesNotMatch(text, /"id"|last_slot|assistant_id|Example Street/);
  assert.deepEqual(w.asks, [{ question: "Which shops do you trust?", choices: [] }]);
  assert.deepEqual(w.would_like, ["add_to_list"]);
  assert.equal(w.web, true);
  assert.deepEqual(triggerInputs(w), [
    { kind: "event", event: { source: "saved", savedAction: "gift-idea" } },
    { kind: "schedule", days: [5], time: "17:00" },
  ]);
});

test("sharedFromAssistant: edits change the file, and looks can be left out", () => {
  const w = sharedFromAssistant(PENNY, { edits: { instructions: "Check shops for each gift idea.", asks: [{ question: "Budget per gift?", choices: [] }], no_avatar: true, author: "sample-author" } });
  assert.equal(w.instructions, "Check shops for each gift idea.");
  assert.deepEqual(w.asks, [{ question: "Budget per gift?", choices: [] }]);
  assert.equal(w.avatar, null);
  assert.equal(w.author, "sample-author");
});

test("shareSlug", () => {
  assert.equal(shareSlug("Penny", "x"), "penny");
  assert.equal(shareSlug("", "Finds good prices!"), "finds-good-prices");
  assert.equal(shareSlug("", "!!!"), "assistant");
});

// ---------- links into the owner's Athena ----------

test("scrubText takes out athena:// links, the site's own links and record ids", () => {
  const input = [
    "See [the gift list](athena://note/3f1c2d4e-1111-4222-8333-444455556666) first.",
    "Open https://athena.example.com/#/team/abc and <athena://person/x>.",
    "Keep https://github.com/sample-author/repo as it is.",
    "Id 3f1c2d4e-1111-4222-8333-444455556666 too.",
  ].join("\n");
  const { text, removed } = scrubText(input, ["athena.example.com"]);
  assert.doesNotMatch(text, /athena:|athena\.example\.com|3f1c2d4e/);
  assert.match(text, /See the gift list first\./);
  assert.match(text, /https:\/\/github\.com\/sample-author\/repo/);
  assert.deepEqual(Object.fromEntries(removed.map((r) => [r.kind, r.count])), { "athena-link": 2, "site-link": 1, "record-id": 1 });
  assert.deepEqual(scrubText("Nothing here.", ["athena.example.com"]), { text: "Nothing here.", removed: [] });
});

// ---------- the personal-data check ----------

const KNOWN: KnownTerm[] = [
  { term: "Priya Shah", kind: "person" },
  { term: "Priya", kind: "person", loose: true },
  { term: "Will", kind: "person", loose: true },
  { term: "priya@acme.example.org", kind: "email" },
  { term: "Home", kind: "place" },
  { term: "Example Bakery", kind: "organisation" },
  { term: "12 Example Street", kind: "address" },
  { term: "Sam", kind: "you", loose: true },
];

test("findPersonal: known names, whole words only, merged across fields", () => {
  const f = findPersonal(
    [
      { field: "instructions", text: "Ask Priya Shah before buying. Priya likes Example Bakery." },
      { field: "skill", text: "Deliver to 12 Example Street. Sam pays." },
    ],
    KNOWN,
  );
  const ids = f.map((x) => x.id).sort();
  assert.deepEqual(ids, ["address:12 example street", "organisation:example bakery", "person:priya", "person:priya shah", "you:sam"]);
  assert.deepEqual(f.find((x) => x.id === "person:priya shah")!.where, ["instructions"]);
});

test("findPersonal: everyday words, lowercase first names and generic places stay quiet", () => {
  const f = findPersonal([{ field: "instructions", text: "I will check from home. priyanka and samosa aren't names here." }], KNOWN);
  assert.deepEqual(f, []);
});

test("findPersonal: email addresses, phone numbers and private links, unless made up", () => {
  const f = findPersonal(
    [
      {
        field: "instructions",
        text: "Email ana@mail.test or test@example.com. Call +44 20 7946 0000 or 07700 900123. Notes: https://docs.google.com/document/d/abc and https://github.com/x/y. Due 2026-11-20.",
      },
    ],
    [],
  );
  assert.deepEqual(f.map((x) => x.kind).sort(), ["email", "link", "phone"]);
  assert.equal(f.find((x) => x.kind === "email")!.term, "ana@mail.test");
  assert.equal(findPersonal([{ field: "job", text: "See https://docs.google.com/document/d/abc." }], [])[0].term, "https://docs.google.com/document/d/abc", "a sentence's full stop isn't part of the link");
});

test("findPersonal: a nickname kept lowercased still counts when written as a name", () => {
  const f = findPersonal([{ field: "instructions", text: "Remind me about Bunny's birthday. A bunny is not a name here." }], [{ term: "bunny", kind: "person", loose: true }]);
  assert.deepEqual(f.map((x) => [x.id, x.term]), [["person:bunny", "Bunny"]]);
});

test("findPersonal: what the owner marked fine stays fine", () => {
  const f = findPersonal([{ field: "job", text: "Plans meals for Priya" }], KNOWN, ["person:priya"]);
  assert.deepEqual(f, []);
});

test("checkFields covers every text a shared and its skill carry", () => {
  const w = sharedFromAssistant(PENNY);
  const fields = checkFields(w, { body: "Body", files: [{ path: "shops.md", text: "List" }] }).map((x) => x.field);
  for (const f of ["name", "job", "instructions", "greeting", "asks", "skill", "file:shops.md"]) assert.ok(fields.includes(f), f);
});

// ---------- folders, zips and links ----------

const enc = (s: string) => new TextEncoder().encode(s);
const SKILL = "---\nname: gift-prices\ndescription: How to check gift prices.\n---\n\n1. Read the gift idea.\n2. Check each trusted shop for its price.\n";

test("bundleFromEntries: the shallowest assistant.json, with the SKILL.md and files beside it", () => {
  const b = bundleFromEntries(
    [
      { path: "gift-prices/assistant.json", bytes: enc(JSON.stringify(minimal({ name: "Penny" }))) },
      { path: "gift-prices/SKILL.md", bytes: enc(SKILL) },
      { path: "gift-prices/shops.md", bytes: enc("# Shops\n") },
      { path: "gift-prices/run.sh", bytes: enc("echo") },
      { path: "gift-prices/.git/config", bytes: enc("x") },
      { path: "__MACOSX/gift-prices/assistant.json", bytes: enc("x") },
    ],
    { kind: "upload", at: "2026-11-20T00:00:00Z" },
  );
  assert.equal(b.shared.name, "Penny");
  assert.match(b.skill!.body, /trusted shop/);
  assert.deepEqual(b.skill!.files.map((f) => f.path), ["shops.md"]);
  assert.deepEqual(b.skill!.skipped.map((f) => f.path), ["run.sh"]);
});

test("bundleFromEntries: no SKILL.md is fine; a skill on its own, two shared assistants or bad JSON are refused", () => {
  assert.equal(bundleFromText(JSON.stringify(minimal()), { kind: "upload", at: "" }).skill, null);
  assert.throws(() => bundleFromEntries([{ path: "SKILL.md", bytes: enc(SKILL) }], { kind: "upload", at: "" }), /That's a skill/);
  assert.throws(() => bundleFromEntries([{ path: "a/assistant.json", bytes: enc("{}") }, { path: "b/assistant.json", bytes: enc("{}") }], { kind: "upload", at: "" }), /more than one/);
  assert.throws(() => bundleFromText("{", { kind: "upload", at: "" }), /valid JSON/);
});

test("parseShareLink: GitHub folders and files only", () => {
  assert.deepEqual(parseShareLink("https://github.com/sample-author/athena-assistants/tree/main/gift-prices"), { kind: "github", owner: "sample-author", repo: "athena-assistants", ref: "main", path: "gift-prices" });
  assert.deepEqual(parseShareLink("https://github.com/sample-author/athena-assistants/blob/main/gift-prices/assistant.json"), { kind: "github", owner: "sample-author", repo: "athena-assistants", ref: "main", path: "gift-prices" });
  assert.deepEqual(parseShareLink("https://raw.githubusercontent.com/sample-author/athena-assistants/main/gift-prices/assistant.json"), { kind: "github", owner: "sample-author", repo: "athena-assistants", ref: "main", path: "gift-prices" });
  assert.deepEqual(parseShareLink("https://github.com/sample-author/one-assistant"), { kind: "github", owner: "sample-author", repo: "one-assistant", ref: null, path: "" });
  assert.throws(() => parseShareLink("https://athena.example.com/assistant.json"), /imports assistants from GitHub/);
  assert.throws(() => parseShareLink("http://github.com/a/b"), /https/);
  assert.throws(() => parseShareLink("https://github.com/a/b/blob/main/readme.md"), /assistant.json/);
});

// ---------- adding one ----------

test("grantedTools: only tools it asked for and the owner ticked", () => {
  assert.deepEqual(grantedTools({ would_like: ["add_todo", "save_note"] }, ["add_todo", "remember", 3]), ["add_todo"]);
  assert.deepEqual(grantedTools({ would_like: ["add_todo"] }, undefined), []);
});

test("withAnswers adds the owner's answers to the skill", () => {
  assert.equal(answersSection([]), "");
  const body = withAnswers("1. Do the job.", [{ question: "Budget per gift?", answer: "Under £30" }, { question: "", answer: "dropped" }]);
  assert.match(body, /## What your owner told you when they added you\n\n- Budget per gift\? Under £30\n$/);
});

test("needsOf and linkedHosts", () => {
  assert.deepEqual(needsOf([{ kind: "event", event: { source: "collected", connector: "gmail" } }, { kind: "schedule", days: [1], time: "08:00" }], ["linear", "gmail"]), ["gmail", "linear"]);
  assert.deepEqual(linkedHosts(["See https://www.shop.example.org/x and https://github.com/a/b"]), ["shop.example.org"]);
});
