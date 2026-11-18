/**
 * Replies for the Life log adapters' tests (trakt-direct, youtube-direct,
 * feeds-direct), and a fetch stub that serves them.
 *
 * Recorded on 7 Nov 2026, then made anonymous (member names, titles and
 * review text changed, structure and markup kept byte for byte):
 *  - a public Letterboxd diary feed (letterboxd.com/<name>/rss/);
 *  - Goodreads' shelf grid and bookshelf widgets (review/grid_widget,
 *    review/custom_widget), and the "widget is not correct" reply for a
 *    member that isn't there;
 *  - Trakt's refusals: a wrong API key (403 "Forbidden") and a dead refresh
 *    token (400 invalid_grant);
 *  - YouTube's 401 for a token it doesn't accept.
 * Trakt's and YouTube's lists follow their API docs (no account to record from).
 */

// ---------- fetch stub ----------

export type Reply = { status?: number; body: unknown; headers?: Record<string, string>; text?: boolean };
export type Route = (url: URL, init: RequestInit) => Reply | undefined;

export const calls: Array<{ url: URL; init: RequestInit }> = [];
let routes: Route[] = [];
const realFetch = globalThis.fetch;

export function stub(...r: Route[]) {
  routes = r;
}

export function installFetch() {
  calls.length = 0;
  routes = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (!reply) continue;
      const raw = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      const type = typeof reply.body === "string" ? "text/plain" : "application/json";
      return new Response(reply.status === 204 ? null : raw, { status: reply.status ?? 200, headers: { "Content-Type": type, ...reply.headers } });
    }
    throw new Error(`No fixture for ${init.method ?? "GET"} ${url.host}${url.pathname}${url.search}`);
  }) as typeof fetch;
}

export function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ---------- Letterboxd ----------

export const LETTERBOXD_RSS = `<?xml version='1.0' encoding='utf-8'?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
	<channel>
		<title>Letterboxd - yourname</title>
		<link>https://letterboxd.com/yourname/</link>
		<description>Letterboxd - yourname</description>
		<atom:link rel="self" href="https://letterboxd.com/yourname/rss/" type="application/rss+xml"/>


			<item> <title>Paddington in Peru, 2024 - ★★★★½</title> <link>https://letterboxd.com/yourname/film/paddington-in-peru/</link> <guid isPermaLink="false">letterboxd-review-1573301804</guid> <pubDate>Fri, 6 Nov 2026 22:39:36 +0000</pubDate> <letterboxd:watchedDate>2026-11-06</letterboxd:watchedDate> <letterboxd:rewatch>No</letterboxd:rewatch> <letterboxd:filmTitle>Paddington in Peru</letterboxd:filmTitle> <letterboxd:filmYear>2024</letterboxd:filmYear> <letterboxd:memberRating>4.5</letterboxd:memberRating> <letterboxd:memberLike>Yes</letterboxd:memberLike> <tmdb:movieId>516729</tmdb:movieId> <description><![CDATA[ <p><img src="https://a.ltrbxd.com/resized/film-poster/5/1/6/7/2/9/516729-paddington-in-peru-0-600-0-900-crop.jpg?v=26b0255349"/></p> <p>Olivia Colman singing &amp; the marmalade bit. Took Mum.</p> ]]></description> <dc:creator>yourname</dc:creator> </item>
			<item> <title>Top 10 of 2026</title> <link>https://letterboxd.com/yourname/list/top-10-of-2026/</link> <guid isPermaLink="false">letterboxd-list-77712</guid> <pubDate>Thu, 5 Nov 2026 20:00:00 +0000</pubDate> <description><![CDATA[ <p>A list.</p> ]]></description> <dc:creator>yourname</dc:creator> </item>
			<item> <title>Heat, 1995</title> <link>https://letterboxd.com/yourname/film/heat-1995/1/</link> <guid isPermaLink="false">letterboxd-watch-1560494967</guid> <pubDate>Thu, 5 Nov 2026 23:01:20 +0000</pubDate> <letterboxd:watchedDate>2026-11-05</letterboxd:watchedDate> <letterboxd:rewatch>Yes</letterboxd:rewatch> <letterboxd:filmTitle>Heat</letterboxd:filmTitle> <letterboxd:filmYear>1995</letterboxd:filmYear> <letterboxd:memberLike>No</letterboxd:memberLike> <tmdb:movieId>949</tmdb:movieId> <description><![CDATA[ <p><img src="https://a.ltrbxd.com/resized/film-poster/5/1/0/5/1/51051-heat-0-600-0-900-crop.jpg?v=0cd1782b5a"/></p> <p>Watched on Thursday November 5, 2026.</p> ]]></description> <dc:creator>yourname</dc:creator> </item>
			<item> <title>Past Lives, 2023 - ★★★★</title> <link>https://letterboxd.com/yourname/film/past-lives/</link> <guid isPermaLink="false">letterboxd-review-1500000001</guid> <pubDate>Sun, 1 Nov 2026 21:10:00 +0000</pubDate> <letterboxd:watchedDate>2026-11-01</letterboxd:watchedDate> <letterboxd:rewatch>No</letterboxd:rewatch> <letterboxd:filmTitle>Past Lives</letterboxd:filmTitle> <letterboxd:filmYear>2023</letterboxd:filmYear> <letterboxd:memberRating>4.0</letterboxd:memberRating> <letterboxd:memberLike>No</letterboxd:memberLike> <tmdb:movieId>666277</tmdb:movieId> <description><![CDATA[ <p><img src="https://a.ltrbxd.com/resized/film-poster/6/6/6/2/7/7/666277-past-lives-0-600-0-900-crop.jpg?v=1"/></p> <p>The bar scene.</p> ]]></description> <dc:creator>yourname</dc:creator> </item>
	</channel>
</rss>`;

// ---------- Goodreads ----------

/** review/grid_widget/<id>?shelf=read: titles and review links, newest first. */
export const GOODREADS_GRID_READ = `  var widget_code = '    <h2>\\n      <a style=\\"text-decoration: none;\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/list/12345-yourname?shelf=read&amp;utm_medium=api&amp;utm_source=grid_widget\\">Your Name&#39;s books<\\/a>\\n    <\\/h2>\\n  <div class=\\"gr_grid_container\\">\\n    <div class=\\"gr_grid_book_container\\"><a title=\\"Tell Me Everything (Amgash, #5)\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9048955118?utm_medium=api&amp;utm_source=grid_widget\\"><img alt=\\"Tell Me Everything\\" border=\\"0\\" src=\\"https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1726253855l/204811915._SY75_.jpg\\" /><\\/a><\\/div>\\n    <div class=\\"gr_grid_book_container\\"><a title=\\"Orbital\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9034889193?utm_medium=api&amp;utm_source=grid_widget\\"><img alt=\\"Orbital\\" border=\\"0\\" src=\\"https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1719373634l/215363519._SY75_.jpg\\" /><\\/a><\\/div>\\n    <div class=\\"gr_grid_book_container\\"><a title=\\"Piranesi\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9034813988?utm_medium=api&amp;utm_source=grid_widget\\"><img alt=\\"Piranesi\\" border=\\"0\\" src=\\"https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1686761184l/62919847._SY75_.jpg\\" /><\\/a><\\/div>\\n    <br style=\\"clear: both\\"/><br/><a class=\\"gr_grid_branding\\" style=\\"font-size: .9em; color: #382110; text-decoration: none; float: right; clear: both\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/user/show/12345-yourname\\">Your Name\\'s favorite books &raquo;<\\/a>\\n  <\\/div>\\n'
  var widget_div = document.getElementById('gr_grid_widget_')
  if (widget_div) {
    widget_div.innerHTML = widget_code
  }
  else {
    document.write(widget_code)
  }
`;

/** review/grid_widget/<id>?shelf=currently-reading */
export const GOODREADS_GRID_READING = `  var widget_code = '    <h2>\\n      <a style=\\"text-decoration: none;\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/list/12345-yourname?shelf=currently-reading&amp;utm_medium=api&amp;utm_source=grid_widget\\">Your Name&#39;s books<\\/a>\\n    <\\/h2>\\n  <div class=\\"gr_grid_container\\">\\n    <div class=\\"gr_grid_book_container\\"><a title=\\"The Wager\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9032334492?utm_medium=api&amp;utm_source=grid_widget\\"><img alt=\\"The Wager\\" border=\\"0\\" src=\\"https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1792233074l/123314798._SX50_.jpg\\" /><\\/a><\\/div>\\n  <\\/div>\\n'
  var widget_div = document.getElementById('gr_grid_widget_')
`;

/** review/custom_widget/<id>: the latest books read, with author, rating and review. */
export const GOODREADS_DETAIL = `  var widget_code = '  <div class=\\"gr_custom_container_1\\">\\n    <h2 class=\\"gr_custom_header_1\\">\\n    <a style=\\"text-decoration: none;\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/list/12345-yourname?shelf=read&amp;utm_medium=api&amp;utm_source=custom_widget\\">Your Name&#39;s books<\\/a>\\n    <\\/h2>\\n      <div class=\\"gr_custom_each_container_1\\">\\n          <div class=\\"gr_custom_book_container_1\\">\\n            <a title=\\"Tell Me Everything (Amgash, #5)\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9048955118?utm_medium=api&amp;utm_source=custom_widget\\"><img alt=\\"Tell Me Everything\\" border=\\"0\\" src=\\"https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1726253855l/204811915._SY75_.jpg\\" /><\\/a>\\n          <\\/div>\\n          <div class=\\"gr_custom_rating_1\\">\\n            <span class=\\" staticStars notranslate\\" title=\\"really liked it\\"><img style=\\"width:15px;height:15px\\" alt=\\"really liked it\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_active.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_active.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_active.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_active.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_inactive.png\\" /><\\/span>\\n          <\\/div>\\n          <div class=\\"gr_custom_title_1\\">\\n            <a rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9048955118?utm_medium=api&amp;utm_source=custom_widget\\">Tell Me Everything<\\/a>\\n          <\\/div>\\n          <div class=\\"gr_custom_author_1\\">\\n            by <a rel=\\"nofollow\\" href=\\"https://www.goodreads.com/author/show/97313.Elizabeth_Strout\\">Elizabeth Strout<\\/a>\\n          <\\/div>\\n          <div class=\\"gr_custom_review_1\\">\\n            Lucy and Bob again. I\\'d read the next one tomorrow.\\n          <\\/div>\\n      <\\/div>\\n      <div class=\\"gr_custom_each_container_1\\">\\n          <div class=\\"gr_custom_book_container_1\\">\\n            <a title=\\"Orbital\\" rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9034889193?utm_medium=api&amp;utm_source=custom_widget\\"><img alt=\\"Orbital\\" border=\\"0\\" src=\\"https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1719373634l/215363519._SY75_.jpg\\" /><\\/a>\\n          <\\/div>\\n          <div class=\\"gr_custom_rating_1\\">\\n            <span class=\\" staticStars notranslate\\"><img style=\\"width:15px;height:15px\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_inactive.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_inactive.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_inactive.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_inactive.png\\" /><img style=\\"width:15px;height:15px\\" alt=\\"\\" src=\\"https://s.gr-assets.com/images/layout/gr_flat_red_star_inactive.png\\" /><\\/span>\\n          <\\/div>\\n          <div class=\\"gr_custom_title_1\\">\\n            <a rel=\\"nofollow\\" href=\\"https://www.goodreads.com/review/show/9034889193?utm_medium=api&amp;utm_source=custom_widget\\">Orbital<\\/a>\\n          <\\/div>\\n          <div class=\\"gr_custom_author_1\\">\\n            by <a rel=\\"nofollow\\" href=\\"https://www.goodreads.com/author/show/2919.Samantha_Harvey\\">Samantha  Harvey<\\/a>\\n          <\\/div>\\n      <\\/div>\\n  <\\/div>\\n'
  var widget_div = document.getElementById('gr_custom_widget_1')
`;

export const GOODREADS_NOT_CORRECT = `  var widget_code = '  This <a rel=\\"nofollow\\" href=\\"https://www.goodreads.com/\\">goodreads<\\/a>\\n  widget is not correct. Get the corrected widget code\\n  <a rel=\\"nofollow\\" href=\\"https://www.goodreads.com/user/edit#widgets\\">here<\\/a>\\n'
  var widget_div = document.getElementById('gr_grid_widget_')
`;

// ---------- Trakt ----------

export const TRAKT_SETTINGS = { user: { username: "yourname", private: false, name: "Your Name", ids: { slug: "yourname" } }, account: { timezone: "Europe/London" } };

export const TRAKT_HISTORY_PAGE_1 = [
  {
    id: 9001,
    watched_at: "2026-11-06T21:14:00.000Z",
    action: "scrobble",
    type: "episode",
    episode: { season: 2, number: 3, title: "Who Is Alive?", ids: { trakt: 1, slug: null } },
    show: { title: "Severance", year: 2022, ids: { trakt: 2, slug: "severance" } },
  },
  {
    id: 9000,
    watched_at: "2026-11-06T19:02:00.000Z",
    action: "watch",
    type: "movie",
    movie: { title: "Paddington in Peru", year: 2024, ids: { trakt: 3, slug: "paddington-in-peru-2024" } },
  },
];
export const TRAKT_HISTORY_PAGE_2 = [
  {
    id: 8999,
    watched_at: "2026-11-06T00:30:00.000Z",
    action: "scrobble",
    type: "episode",
    episode: { season: 2, number: 2, title: "Goodbye, Mrs. Selvig", ids: { trakt: 4 } },
    show: { title: "Severance", year: 2022, ids: { trakt: 2, slug: "severance" } },
  },
];

export const TRAKT_RATINGS = [
  { rated_at: "2026-11-06T21:20:00.000Z", rating: 9, type: "episode", episode: { season: 2, number: 3, title: "Who Is Alive?" }, show: { title: "Severance", ids: { slug: "severance" } } },
  { rated_at: "2026-10-20T10:00:00.000Z", rating: 6, type: "movie", movie: { title: "Old Film", year: 1990, ids: { slug: "old-film-1990" } } },
];

export const TRAKT_WATCHLIST = [{ rank: 1, id: 5, listed_at: "2026-10-01T09:00:00.000Z", type: "show", show: { title: "Slow Horses", year: 2022, ids: { slug: "slow-horses" } } }];

export const TRAKT_PLAYBACK = [{ progress: 41.6, paused_at: "2026-11-06T22:40:00.000Z", id: 13, type: "movie", movie: { title: "Dune", year: 2021, ids: { slug: "dune-2021" } } }];

/** Recorded: api.trakt.tv with an API key it doesn't know (text/plain). */
export const LIVE_TRAKT_BAD_KEY = "Forbidden";
/** Recorded: api.trakt.tv/oauth/token with a refresh token it doesn't know. */
export const LIVE_TRAKT_DEAD_REFRESH = { error_description: "session not found", error: "invalid_grant" };

// ---------- YouTube ----------

export const YT_CHANNEL = { kind: "youtube#channelListResponse", items: [{ id: "UC123", contentDetails: { relatedPlaylists: { likes: "LL", uploads: "UU123" } } }] };
export const YT_NO_CHANNEL = { kind: "youtube#channelListResponse", pageInfo: { totalResults: 0, resultsPerPage: 5 } };

const yItem = (title: string, channel: string, added: string, id: string) => ({
  kind: "youtube#playlistItem",
  snippet: { publishedAt: added, title, videoOwnerChannelTitle: channel, resourceId: { kind: "youtube#video", videoId: id } },
  contentDetails: { videoId: id, videoPublishedAt: "2026-01-01T00:00:00Z" },
});

export const YT_LIKES_PAGE_1 = {
  nextPageToken: "CAIQAA",
  items: [
    yItem("How the Thames Barrier works", "Practical Engineering", "2026-11-06T20:05:00Z", "vid1"),
    yItem("Deleted video", "", "2026-11-06T19:00:00Z", "gone"),
    yItem("A week in Lisbon", "Kara and Nate", "2026-11-06T08:00:00Z", "vid2"),
  ],
};
export const YT_LIKES_PAGE_2 = { nextPageToken: "CAQQAA", items: [yItem("Bread at home", "Joshua Weissman", "2026-11-05T22:00:00Z", "vid3")] };

export const YT_PLAYLISTS = {
  items: [{ id: "PLabc", snippet: { title: "Watch this weekend", publishedAt: "2026-03-01T10:00:00Z" }, contentDetails: { itemCount: 7 }, status: { privacyStatus: "private" } }],
};

export const YT_SUBSCRIPTIONS = {
  items: [
    { snippet: { publishedAt: "2026-11-06T12:00:00Z", title: "Tom Scott", resourceId: { kind: "youtube#channel", channelId: "UCts" } } },
    { snippet: { publishedAt: "2024-02-01T12:00:00Z", title: "Veritasium", resourceId: { kind: "youtube#channel", channelId: "UCve" } } },
  ],
};

/** Recorded: the YouTube Data API with a token it doesn't accept. */
export const LIVE_YT_401 = {
  error: {
    code: 401,
    message: "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
    errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError", location: "Authorization", locationType: "header" }],
    status: "UNAUTHENTICATED",
  },
};

export const YT_API_OFF = {
  error: {
    code: 403,
    message: "YouTube Data API v3 has not been used in project 123456789012 before or it is disabled.",
    errors: [{ message: "Access Not Configured.", domain: "usageLimits", reason: "accessNotConfigured" }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { consumer: "projects/123456789012", service: "youtube.googleapis.com" } }],
  },
};
