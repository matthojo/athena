/**
 * Recorded replies for the Readwise, Bluesky and Mastodon tests, and a fetch stub.
 *
 * Shapes are as the services returned them on 7 Nov 2026, trimmed and
 * anonymised: Bluesky's public AppView (getProfile, getAuthorFeed, a profile
 * that doesn't exist), Mastodon's statuses and its bad-token reply, and
 * Readwise's bad-token reply. Readwise export bodies follow its documented
 * shape (readwise.io/api_deets), since reading one needs a real library.
 */

export type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
export type Route = (url: URL, init: RequestInit) => Reply | undefined;

export const calls: Array<{ url: URL; init: RequestInit }> = [];
let routes: Route[] = [];
const realFetch = globalThis.fetch;

/** Answer fetches from these routes, in order; anything unrouted fails the test. */
export function stub(...r: Route[]): void {
  routes = r;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const route of routes) {
      const reply = route(url, init);
      if (reply) {
        const status = reply.status ?? 200;
        return new Response(status === 204 ? null : JSON.stringify(reply.body), { status, headers: { "Content-Type": "application/json", ...reply.headers } });
      }
    }
    throw new Error(`No fixture for ${url.host}${url.pathname}`);
  }) as typeof fetch;
}

export function unstub(): void {
  globalThis.fetch = realFetch;
}

export const at =
  (host: string, path: string, body: ((url: URL) => unknown) | Record<string, unknown> | unknown[], status = 200): Route =>
  (url) =>
    url.host === host && url.pathname === path ? { status, body: typeof body === "function" ? (body as (u: URL) => unknown)(url) : body } : undefined;

// ---------- Readwise ----------

/** The real reply to a token Readwise doesn't know (GET /api/v2/auth/ and /export/). */
export const READWISE_BAD_TOKEN = { detail: "Invalid token." };

const hl = (id: number, text: string, created: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  note: "",
  location: 1200 + id,
  location_type: "location",
  highlighted_at: created,
  created_at: created,
  updated_at: created,
  external_id: null,
  end_location: null,
  url: null,
  book_id: 41,
  tags: [],
  is_favorite: false,
  is_discard: false,
  readwise_url: `https://readwise.io/open/${id}`,
  ...extra,
});

export const WAGER = {
  user_book_id: 41,
  title: "The Wager",
  readable_title: "The Wager",
  author: "David Grann",
  source: "kindle",
  cover_image_url: "https://images-na.ssl-images-amazon.com/images/I/x.jpg",
  unique_url: null,
  book_tags: [],
  category: "books",
  document_note: null,
  readwise_url: "https://readwise.io/bookreview/41",
  source_url: null,
  asin: "B09MDN9Z9V",
  highlights: [
    // 6 Nov, London: two highlights and a note; one discarded.
    hl(1001, "The sea was a great leveller.", "2026-11-06T21:10:00Z", { note: "Like the café scene" }),
    hl(1002, "Scurvy was the plague of the sea.", "2026-11-06T21:40:00Z", { tags: [{ id: 5, name: "history" }] }),
    hl(1003, "A line he deleted.", "2026-11-06T22:00:00Z", { is_discard: true }),
    // Read on 5 Nov on the Kindle, synced to Readwise on 6 Nov.
    hl(1004, "Mutiny is a matter of perspective.", "2026-11-06T08:00:00Z", { highlighted_at: "2026-11-05T22:30:00Z" }),
  ],
};

export const ESSAY = {
  user_book_id: 77,
  title: "How to Do Great Work",
  readable_title: "How to Do Great Work",
  author: "Paul Graham",
  source: "reader",
  unique_url: "https://paulgraham.com/greatwork.html",
  book_tags: [{ id: 9, name: "craft" }],
  category: "articles",
  readwise_url: "https://readwise.io/bookreview/77",
  source_url: "https://paulgraham.com/greatwork.html",
  highlights: [hl(2001, "Curiosity is the engine of great work.", "2026-11-06T12:00:00Z"), hl(2002, "An earlier one.", "2026-11-01T12:00:00Z")],
};

export const APPLE = {
  user_book_id: 90,
  title: "Four Thousand Weeks",
  readable_title: "Four Thousand Weeks",
  author: "Oliver Burkeman",
  source: "ibooks",
  category: "books",
  readwise_url: "https://readwise.io/bookreview/90",
  highlights: [hl(3001, "The day will never come when you have everything under control.", "2026-10-20T07:00:00Z")],
};

// ---------- Bluesky ----------

export const BSKY_DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
export const BSKY_PROFILE = { did: BSKY_DID, handle: "jordan.bsky.social", displayName: "Jordan", postsCount: 120, labels: [], createdAt: "2023-04-12T04:53:57.057Z" };
/** The real reply for a handle nobody has (getProfile and getAuthorFeed alike). */
export const BSKY_NOT_FOUND = { error: "InvalidRequest", message: "Profile not found" };

const OTHER = "did:plc:djuj57armcsoyzmdfeg7i4qf";

const post = (rkey: string, createdAt: string, text: string, extra: Record<string, unknown> = {}, author = BSKY_DID) => ({
  uri: `at://${author}/app.bsky.feed.post/${rkey}`,
  cid: `bafyrei${rkey}`,
  author: { did: author, handle: author === BSKY_DID ? "jordan.bsky.social" : "someone.bsky.social" },
  record: { $type: "app.bsky.feed.post", createdAt, langs: ["en"], text },
  bookmarkCount: 0,
  replyCount: 2,
  repostCount: 3,
  likeCount: 70,
  quoteCount: 0,
  indexedAt: createdAt.replace(/\.\d+Z$/, ".880Z"),
  ...extra,
});

const repost = (p: ReturnType<typeof post>) => ({ post: p, reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { did: BSKY_DID, handle: "jordan.bsky.social" }, indexedAt: p.indexedAt } });

/** Newest first. A repost of someone's October post sits between November ones, as getAuthorFeed sorts reposts by when they were reposted. */
export const BSKY_PAGE_1 = {
  feed: [
    repost(post("3mzod4qisq22c", "2026-11-06T21:26:54.007Z", "if you've never seen a Capuchinbird, here you go", { embed: { $type: "app.bsky.embed.video#view" } }, OTHER)),
    {
      post: post("3mznvxo7so22q", "2026-11-06T17:31:25.201Z", "this is so cool", {
        record: {
          $type: "app.bsky.feed.post",
          createdAt: "2026-11-06T17:31:25.201Z",
          text: "this is so cool",
          reply: { parent: { uri: `at://${OTHER}/app.bsky.feed.post/3mznvf4jkdc2m` }, root: { uri: `at://${OTHER}/app.bsky.feed.post/3mznvf4jkdc2m` } },
        },
      }),
    },
    { post: post("3mznquote22a", "2026-11-06T09:15:00.000Z", "Exactly this.", { embed: { $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.embed.record#viewRecord", uri: `at://${OTHER}/app.bsky.feed.post/3mzkeyquote` } } }) },
    repost(post("3mzold00old2c", "2026-10-19T20:52:31.118Z", "To make a plan to vote, visit the website", {}, OTHER)),
    { post: post("3mzhhvhjfwk22", "2026-11-04T04:03:40.249Z", "Traffic is up 200% tonight", { embed: { $type: "app.bsky.embed.images#view", images: [{ alt: "a chart" }] } }) },
  ],
  cursor: "2026-11-04T04:03:40.249Z",
};

export const BSKY_PAGE_2 = {
  feed: [
    { post: post("3mzg7ufzqwc2u", "2026-11-03T16:07:15.462Z", "Pacific newsrooms", { embed: { $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.graph.defs#starterPackViewBasic", uri: `at://${BSKY_DID}/app.bsky.graph.starterpack/3abc` } } }) },
    { post: post("3mzf00000002a", "2026-10-30T17:34:58.470Z", "To try the moderation inbox, enable beta", { embed: { $type: "app.bsky.embed.external#view", external: { uri: "https://bsky.social/about/blog", title: "Blog" } } }) },
  ],
  cursor: "2026-10-30T17:34:58.47Z",
};

// ---------- Mastodon ----------

/** The real reply to a token the server doesn't know. */
export const MASTO_BAD_TOKEN = { error: "The access token is invalid" };
export const MASTO_NO_SCOPE = { error: "This action is outside the authorized scopes" };
export const MASTO_ME = { id: "13179", username: "jordan", acct: "jordan", display_name: "Jordan", url: "https://mastodon.social/@jordan", statuses_count: 812 };

const status = (id: string, created_at: string, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  created_at,
  in_reply_to_id: null,
  in_reply_to_account_id: null,
  sensitive: false,
  spoiler_text: "",
  visibility: "public",
  language: "en",
  uri: `https://mastodon.social/users/jordan/statuses/${id}`,
  url: `https://mastodon.social/@jordan/${id}`,
  replies_count: 20,
  reblogs_count: 225,
  favourites_count: 442,
  quotes_count: 1,
  edited_at: null,
  content,
  reblog: null,
  account: { id: "13179" },
  media_attachments: [],
  quote: null,
  card: null,
  ...extra,
});

export const MASTO_PAGE_1 = [
  status("117470000000000005", "2026-11-06T21:59:05.999Z", "<p>Late one.</p>", { visibility: "unlisted" }),
  // A boost: its own id and time, someone else's post inside.
  status("117470000000000004", "2026-11-06T18:00:00.000Z", "", { reblog: { id: "9", content: "<p>Someone else</p>", account: { id: "55" } } }),
  status("117470000000000003", "2026-11-06T09:58:40.113Z", "<p><span class=\"h-card\"><a href=\"https://example.social/@alex\" class=\"u-url mention\">@<span>alex</span></a></span> agreed, it&#39;s &amp; always was.</p><p>Second line<br>third</p>", {
    in_reply_to_id: "117469000000000001",
    in_reply_to_account_id: "55",
  }),
  // A private mention is a message: never returned.
  status("117470000000000002", "2026-11-06T08:00:00.000Z", "<p>Psst</p>", { visibility: "direct" }),
  status("117466985005297414", "2026-11-05T09:59:05.999Z", "<p>Our new forum: <a href=\"https://community.joinmastodon.org/\"><span class=\"invisible\">https://</span><span class=\"\">community.joinmastodon.org/</span><span class=\"invisible\"></span></a></p>", {
    card: { url: "https://community.joinmastodon.org/", title: "Mastodon Community Forum" },
    spoiler_text: "meta",
    media_attachments: [{ id: "1", type: "image" }],
  }),
];

export const MASTO_PAGE_2 = [status("117411420916699261", "2026-10-09T14:28:25.298Z", "<p>October.</p>")];
