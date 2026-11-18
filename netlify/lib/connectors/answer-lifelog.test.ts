// Run: npx tsx --test netlify/lib/connectors/answer-lifelog.test.ts
// A whole Ask answer from the Life log: the real port (answer-sources.ts), callTool and answerQuestion,
// with the accounts' replies stubbed in the adapters' own shapes and the model scripted. No database:
// Athena's own search fails quietly without one, as it's built to.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connector } from "../../../lib/connectors";
import type { Anthropic } from "../../../lib/ai";
import { answerQuestion, type AnswerReply } from "../../../lib/answer";
import type { DirectAdapter } from "./direct";
import type { OpenConnector } from "./mcp-client";
import { answerSourcesWith } from "./answer-sources";
import { media, traktAdapter } from "./trakt-direct";
import { redditAdapter, redditItem } from "./reddit-direct";
import { spotifyAdapter } from "./spotify-direct";
import { letterboxdAdapter } from "./feeds-letterboxd";

const NOW = new Date("2026-11-07T10:00:00Z");
const TZ = "Europe/London";

function account(id: string, provider: string, name: string, adapter: DirectAdapter, reply: (tool: string, args: Record<string, unknown>) => unknown, calls: string[]) {
  const c = { id, name, provider, account_label: "", status: "connected", scope: "", auth_type: "oauth", oauth: {} } as unknown as Connector;
  const tools = adapter.tools(c);
  c.allowed_tools = tools.map((t) => t.name);
  const open: OpenConnector = {
    connector: c,
    direct: {
      tools,
      async call(tool, args) {
        calls.push(`${provider}.${tool} ${JSON.stringify(args)}`);
        return { text: JSON.stringify(reply(tool, args)), isError: false };
      },
    },
    close: async () => undefined,
  };
  return { c, open };
}

/** A model that runs `plan` (tool name suffix → input) once, then answers from what came back. */
function scripted(plan: Array<[string, Record<string, unknown>]>, answer: (seen: string) => { text: string; sources: Array<{ ref: string; title: string; date: string }> }) {
  const sent: string[] = [];
  let round = 0;
  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        sent.push(JSON.stringify(params.messages), String(params.system));
        const tools = (params.tools ?? []) as Array<{ name: string }>;
        const base = { id: `m${round}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (round++ === 0) {
          const content = plan.map(([suffix, input], i) => {
            const tool = tools.find((t) => t.name.endsWith(suffix));
            assert.ok(tool, `offered ${suffix}: ${tools.map((t) => t.name).join(", ")}`);
            return { type: "tool_use", id: `t${i}`, name: tool.name, input };
          });
          return { ...base, stop_reason: "tool_use", content } as unknown as Anthropic.Message;
        }
        const seen = JSON.stringify(params.messages);
        return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "done", name: "answer", input: { found: true, ...answer(seen) } }] } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

function port(accounts: Array<{ c: Connector; open: OpenConnector }>) {
  return answerSourcesWith({ list: async () => accounts.map((a) => a.c), open: async (id) => accounts.find((a) => a.c.id === id)!.open });
}

const links = (seen: string) => [...seen.matchAll(/https:\/\/[^"\\]+/g)].map((m) => m[0]);

test("“What was I watching in March?” cites a film and an episode from Trakt and a film from Letterboxd, each named for what it is", async () => {
  const calls: string[] = [];
  const trakt = account("t", "trakt", "Trakt", traktAdapter, () => ({
    watched: [
      media({ type: "movie", movie: { title: "Past Lives", year: 2023, ids: { slug: "past-lives-2023" } } } as never, "2026-03-07T20:00:00Z", TZ),
      media({ type: "episode", show: { title: "Slow Horses", ids: { slug: "slow-horses" } }, episode: { season: 4, number: 3, title: "Hello Goodbye" } } as never, "2026-03-08T21:00:00Z", TZ),
    ],
  }), calls);
  const letterboxd = account("l", "letterboxd", "Letterboxd", letterboxdAdapter, () => ({
    films: [{ title: "Aftersun", year: 2022, watched_on: "2026-03-14", rating: "★★★★★ (5/5)", link: "https://letterboxd.com/jordan/film/aftersun/" }],
  }), calls);
  const { client } = scripted(
    [
      ["list_history", { after: "2026-03-01", before: "2026-04-01" }],
      ["list_diary", { after: "2026-03-01", before: "2026-04-01" }],
    ],
    (seen) => {
      const [film, episode] = links(seen).filter((l) => l.includes("trakt.tv"));
      const lb = links(seen).find((l) => l.includes("letterboxd.com/jordan/film"))!;
      return {
        text: "In March you watched Past Lives [1] and Slow Horses [2], and gave Aftersun five stars [3].",
        sources: [
          { ref: film, title: "Past Lives", date: "2026-03-07" },
          { ref: episode, title: "Slow Horses, S4 E3", date: "2026-03-08" },
          { ref: lb, title: "Aftersun", date: "2026-03-14" },
        ],
      };
    },
  );
  const reply: AnswerReply = await answerQuestion("What was I watching in March?", { sources: port([trakt, letterboxd]), client }, { now: NOW, tz: TZ });

  assert.deepEqual(calls, ['trakt.list_history {"after":"2026-03-01","before":"2026-04-01"}', 'letterboxd.list_diary {"after":"2026-03-01","before":"2026-04-01"}']);
  assert.deepEqual(
    reply.sources.map((s) => [s.n, s.kind, s.url, s.title, s.date, s.account]),
    [
      [1, "film", "https://trakt.tv/movies/past-lives-2023", "Past Lives", "2026-03-07", "Trakt"],
      [2, "episode", "https://trakt.tv/shows/slow-horses/seasons/4/episodes/3", "Slow Horses, S4 E3", "2026-03-08", "Trakt"],
      [3, "film", "https://letterboxd.com/jordan/film/aftersun/", "Aftersun", "2026-03-14", "Letterboxd"],
    ],
  );
  assert.equal(reply.found, true);
  assert.match(reply.searched, /Letterboxd and Trakt|Trakt and Letterboxd/);
});

test("“What did I post on Reddit last week?” cites posts and comments; an NSFW post reaches the model and the app by community only", async () => {
  const calls: string[] = [];
  const ctx = { name: "jordan", tz: TZ };
  const item = (kind: "t1" | "t3", data: Record<string, unknown>) => redditItem({ kind, data: { author: "jordan", created_utc: 1_793_000_000, ...data } }, ctx);
  const reddit = account("r", "reddit", "Reddit", redditAdapter, (tool) =>
    tool === "my_posts"
      ? {
          items: [
            item("t3", { subreddit_name_prefixed: "r/espresso", permalink: "/r/espresso/comments/a/grind/", title: "Grind size for a Flair 58?", is_self: true }),
            item("t3", { subreddit_name_prefixed: "r/somewhere", permalink: "/r/somewhere/comments/n/x/", title: "A private title", selftext: "Private text", is_self: true, over_18: true }),
          ],
        }
      : { items: [item("t1", { subreddit_name_prefixed: "r/coffee", permalink: "/r/coffee/comments/c/beans/d/", link_title: "Best beans?", body: "Try a washed Ethiopian." })] },
  calls);
  const { client, sent } = scripted(
    [
      ["my_posts", { after: "2026-10-26", before: "2026-11-02" }],
      ["my_comments", { after: "2026-10-26", before: "2026-11-02" }],
    ],
    (seen) => {
      const l = links(seen);
      return {
        text: "You asked r/espresso about grind size [1], posted in r/somewhere [2] and suggested a washed Ethiopian in r/coffee [3].",
        sources: [
          { ref: l.find((x) => x.includes("/espresso/"))!, title: "Grind size for a Flair 58?", date: "2026-10-27" },
          // The model can't know the NSFW title; even if it made one up, the app shows the community.
          { ref: l.find((x) => x.includes("/somewhere/"))!, title: "Something it guessed", date: "2026-10-27" },
          { ref: l.find((x) => x.includes("/coffee/"))!, title: "Best beans?", date: "2026-10-27" },
        ],
      };
    },
  );
  const reply = await answerQuestion("What did I post on Reddit last week?", { sources: port([reddit]), client }, { now: NOW, tz: TZ });

  assert.equal(calls.length, 2);
  assert.ok(!sent.join("").includes("A private title") && !sent.join("").includes("Private text"), "the NSFW title and text never reach the model");
  assert.deepEqual(
    reply.sources.map((s) => [s.kind, s.url, s.title, s.account]),
    [
      ["post", "https://www.reddit.com/r/espresso/comments/a/grind/", "Grind size for a Flair 58?", "Reddit"],
      ["post", "https://www.reddit.com/r/somewhere/comments/n/_/", "Post in r/somewhere", "Reddit"],
      ["comment", "https://www.reddit.com/r/coffee/comments/c/beans/d/", "Best beans?", "Reddit"],
    ],
  );
});

test("A link no tool returned is dropped, and Spotify tracks come back as tracks", async () => {
  const calls: string[] = [];
  const spotify = account("s", "spotify", "Spotify", spotifyAdapter, () => ({ items: [{ track: "Starburster", artist: "Fontaines D.C.", link: "https://open.spotify.com/track/1" }] }), calls);
  const { client } = scripted([["recently_played", {}]], () => ({
    text: "You played Starburster [1] and something else [2].",
    sources: [
      { ref: "https://open.spotify.com/track/1", title: "Starburster", date: "" },
      { ref: "https://open.spotify.com/track/made-up", title: "Invented", date: "" },
    ],
  }));
  const reply = await answerQuestion("What was I listening to?", { sources: port([spotify]), client }, { now: NOW, tz: TZ });
  assert.deepEqual(reply.sources.map((s) => [s.n, s.kind, s.url]), [[1, "track", "https://open.spotify.com/track/1"]]);
  assert.doesNotMatch(reply.text, /\[2\]/);
});
