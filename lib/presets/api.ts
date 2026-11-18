/**
 * Life-log services reached through their own APIs (first Stage 3 slice: Trakt, YouTube, Letterboxd, Goodreads).
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * None goes through MCP: none of the four publishes an MCP server anyone can
 * use. Athena calls each one itself (netlify/lib/connectors/trakt-*.ts,
 * youtube-direct.ts, feeds-*.ts), GETs only.
 *  - Trakt and YouTube sign in with the owner's own OAuth app (Trakt's, with
 *    PKCE and no client secret, or the Google client Gmail uses).
 *  - Letterboxd and Goodreads need no sign-in: Athena reads the owner's
 *    public profile (Letterboxd's diary feed, Goodreads' shelf widgets), from
 *    the link they paste, on letterboxd.com or
 *    goodreads.com only (the adapter's checkAddress refuses anything else).
 */
import type { ConnectorPreset } from "../connector-presets";

export const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export const API_PRESETS: ConnectorPreset[] = [
  {
    id: "trakt",
    label: "Trakt",
    tagline: "What you watch, rate and save",
    icon: "tv",
    category: "entertainment",
    url: "https://api.trakt.tv",
    auth: "oauth",
    // Trakt has no scopes: read-only is Athena's own rule (GETs only).
    scope: "",
    needsOwnClient: true,
    ownClientLabel: "Trakt",
    noClientSecret: true,
    clientIdHint: "From your Trakt app",
    readTools: ["list_history", "list_watchlist", "list_ratings", "list_in_progress"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Make a free Trakt app for Athena once. At trakt.tv/oauth/applications, choose New application, name it Athena, paste the address above under Redirect URI, and save. Then copy its Client ID into the box above. Athena signs in with PKCE, so it never needs the Client Secret. Athena reads what you watched, your watchlist and your ratings, and never changes anything.",
  },
  {
    id: "youtube",
    label: "YouTube",
    tagline: "Likes, playlists and subscriptions",
    icon: "play",
    category: "entertainment",
    url: "https://www.googleapis.com/youtube/v3",
    auth: "oauth",
    scope: YOUTUBE_READ_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Google",
    readTools: ["list_liked_videos", "list_playlists", "list_playlist_videos", "list_subscriptions"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Use the Google client you made for Gmail, if you have one. In that Google Cloud project, turn on the YouTube Data API v3, add the address above to the client, then paste its ID and secret. YouTube doesn't share your watch history with apps, so Athena sees the videos you like, your playlists and your subscriptions.",
  },
  {
    id: "letterboxd",
    label: "Letterboxd",
    tagline: "Your film diary and ratings",
    icon: "film",
    category: "entertainment",
    url: "",
    urlHint: "https://letterboxd.com/you",
    auth: "none",
    scope: "",
    readTools: ["list_diary"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Paste your profile link. Athena reads the films you log, with your ratings and reviews, from your public diary. No sign-in needed.",
  },
  {
    id: "goodreads",
    label: "Goodreads",
    tagline: "Books you've read and are reading",
    icon: "book",
    category: "entertainment",
    url: "",
    urlHint: "https://goodreads.com/user/show/…",
    auth: "none",
    scope: "",
    readTools: ["list_books"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Paste your profile link. Athena reads your shelves and ratings. Goodreads doesn't share dates, so a book goes in your log on the day Athena first sees it. Your profile must be public. No sign-in needed.",
  },
];

/** Does Athena call this service's own API for the account (direct.ts), rather than an MCP server? Mirrors each adapter's `handles`. */
export function apiADirect(c: { provider: string; auth_type: string }): boolean {
  if (c.provider === "trakt" || c.provider === "youtube") return c.auth_type === "oauth";
  if (c.provider === "letterboxd" || c.provider === "goodreads") return c.auth_type === "none";
  return false;
}
